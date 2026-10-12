import { AntSeedFundingVaultClient } from "./antseed-funding-vault.js";
import { fetchCurrentGdPrice, fetchGoodIdRoot } from "./celo-events.js";
import { configFromEnv } from "./env.js";
import { fundCredit } from "./funding.js";
import { KVCreditStore } from "./kv-credit-store.js";
import { UserCreditProfile } from "./types.js";
import { logInfo, logWarn, redactAddress } from "./logging.js";
import { fetchSuperfluidIncomingStreams } from "./superfluid.js";
import { SuperfluidIncomingStream } from "./superfluid.js";

/**
 * Stream credit entries are keyed per account per day, so the scheduled run and a user's own
 * request collapse onto one entry instead of paying the same window twice.
 */
export function createStreamFundingId(account: string, date: Date): string {
  const day = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return `stream:${day}:${account.toLowerCase()}`;
}

/**
 * Seconds of stream to credit on this run: the window from the later of the account's last stream
 * credit and the current stream revision's creation, up to `now`.
 *
 * The window is deliberately not capped: a long gap means the stream really did flow for that
 * whole time (a stalled cron, a backfill), and the credit should reflect it. What must not happen
 * is inventing a window out of a baseline we never had. When neither timestamp is usable the
 * answer is 0, not "since the epoch".
 */
export function streamElapsedSeconds(now: Date, lastStreamCreditAt: string | undefined, streamLastUpdateAt?: string): number {
  const lastCreditMs = lastStreamCreditAt ? Date.parse(lastStreamCreditAt) : 0;
  const lastUpdateMs = streamLastUpdateAt ? Date.parse(streamLastUpdateAt) : 0;
  // The later of the two wins. `lastStreamCreditAt` alone is not enough: it survives a stream being
  // closed, so a user who closes a stream and opens a new one months later would be credited for
  // the whole dormant gap. The stream's last on-chain update is a hard floor -- it moves forward on
  // every create, rate change and close, so a stale clock can never be reached again.
  //
  // The trade-off: it also moves on a plain rate change, so when the resulting `StreamUpdated`
  // event is not ingested (that endpoint is push-only, no retry) the window between the last credit
  // and the rate change is skipped and never paid. Chosen deliberately -- it errs towards
  // under-crediting rather than over-crediting.
  const baselineMs = Math.max(Number.isFinite(lastCreditMs) ? lastCreditMs : 0, Number.isFinite(lastUpdateMs) ? lastUpdateMs : 0);
  if (baselineMs <= 0) {
    logWarn("stream.credits.unusable-baseline", { lastStreamCreditAt, streamLastUpdateAt });
    return 0;
  }
  return Math.max(0, Math.floor((now.getTime() - baselineMs) / 1000));
}

/**
 * What a stream owes credit for, and over what window.
 *
 * Live stream: from the later of the last credit and the stream's last on-chain update, up to now,
 * at the rate the subgraph reports.
 *
 * Closed stream: from the last credit up to the **termination**, at the rate that was flowing before
 * it closed. The end has to be the termination rather than `now` -- the stream stopped carrying G$
 * then, so measuring to `now` would invent time it did not flow.
 *
 * NOTE: this branch has neither a floor (a closed stream's last update *is* its termination) nor a
 * ceiling, so a stale `lastStreamCreditAt` priced at a remembered rate can over-credit. Tracked in
 * the PR notes -- reading `streamPeriods` is the fix, not another guard.
 */
export function streamCreditAmount(input: {
  now: Date;
  lastStreamCreditAt: string | undefined;
  stream: SuperfluidIncomingStream;
  /** The rate recorded before this run zeroed it; only consulted for a closed stream. */
  previousFlowRateWeiPerSecond: bigint;
}): { elapsedSeconds: number; gdAmountWei: bigint } {
  const flowRateWeiPerSecond = BigInt(input.stream.flowRateWeiPerSecond);
  if (flowRateWeiPerSecond > 0n) {
    const elapsedSeconds = streamElapsedSeconds(input.now, input.lastStreamCreditAt, input.stream.lastUpdateAt);
    return { elapsedSeconds, gdAmountWei: flowRateWeiPerSecond * BigInt(elapsedSeconds) };
  }

  const terminatedAtMs = Date.parse(input.stream.lastUpdateAt);
  const lastCreditMs = input.lastStreamCreditAt ? Date.parse(input.lastStreamCreditAt) : 0;
  if (!Number.isFinite(terminatedAtMs) || terminatedAtMs <= 0 || !Number.isFinite(lastCreditMs) || lastCreditMs <= 0) {
    logWarn("stream.credits.unusable-final-window", {
      lastStreamCreditAt: input.lastStreamCreditAt,
      terminatedAt: input.stream.lastUpdateAt
    });
    return { elapsedSeconds: 0, gdAmountWei: 0n };
  }

  const elapsedSeconds = Math.max(0, Math.floor((terminatedAtMs - lastCreditMs) / 1000));
  return { elapsedSeconds, gdAmountWei: input.previousFlowRateWeiPerSecond * BigInt(elapsedSeconds) };
}

/**
 * One pass of stream credit accrual: sync every account's recorded flow rate from the subgraph,
 * then credit each stream the window it is owed and fund it.
 *
 * Split out of the scheduled handler so the orchestration is readable on its own and so the
 * handler is left doing only what a cron entrypoint should -- wire dependencies and sequence the
 * passes. Funding is fired through `ctx.waitUntil` and deliberately not awaited.
 */
export async function runStreamCreditCycle(
  cfg: ReturnType<typeof configFromEnv>,
  store: KVCreditStore,
  antseedFundingVault: AntSeedFundingVaultClient,
  ctx: ExecutionContext,
  startedAt: number
): Promise<void> {
  const gdPrice = await fetchCurrentGdPrice(cfg);
  // Includes closed streams: a terminated stream reports `currentFlowRate = 0`, and seeing that is
  // the only way the backend learns it stopped. The termination event that would otherwise say so
  // is pushed in by `POST /v1/celo/events/record` and may never arrive.
  const streams = await fetchSuperfluidIncomingStreams(cfg);

  let inactiveAccounts = 0;
  let syncedFlowRates = 0;
  let syncedRootFlowRates = 0;
  let skippedCooldown = 0;
  let skippedMinAmount = 0;
  let processed = 0;
  let funded = 0;
  let failed = 0;
  const createdAt = new Date().toISOString();

  // Sync every account's recorded rate from the subgraph before crediting. Doing it here rather
  // than inside `recordGdCredit` means it happens on every run, not only when a credit clears the
  // cooldown and the minimum -- at a 4000 G$ minimum those can be a fortnight apart. Summed per
  // account, because one account can hold several revisions (a closed stream and its replacement)
  // and a closed row must not clobber the rate of the live one. All-closed sums to 0, which is
  // how the profile stops advertising a stream that no longer exists.
  const flowRateByAccount = new Map<string, bigint>();
  for (const stream of streams) {
    const account = stream.account.toLowerCase();
    flowRateByAccount.set(account, (flowRateByAccount.get(account) ?? 0n) + BigInt(stream.flowRateWeiPerSecond));
  }
  // One profile read per account, reused by the crediting pass below. `getSavedUser` rather than
  // `getUser` because syncing is a correction to state that already exists -- an account that has
  // never been credited has no profile, and the scheduled run must not create one as a side
  // effect. Its first credit will create it, in `recordGdCredit`.
  const profileByAccount = new Map<string, UserCreditProfile>();
  const flowRateByRoot = new Map<string, bigint>();
  // The rate as it stood before this run's sync. A stream that has just closed reports 0, so its
  // final window has to be priced at what was flowing beforehand.
  const previousFlowRateByAccount = new Map<string, bigint>();
  for (const [account, flowRate] of flowRateByAccount) {
    const profile = await store.getSavedUser(account);
    if (!profile) continue;
    previousFlowRateByAccount.set(account, BigInt(profile.streamFlowRateWeiPerSecond));
    if (await store.recordStreamFlowRate(profile, flowRate)) syncedFlowRates += 1;
    profileByAccount.set(account, profile);
    flowRateByRoot.set(profile.rootAccount, (flowRateByRoot.get(profile.rootAccount) ?? 0n) + flowRate);
  }

  // A GoodID root profile aggregates its identity's wallets. The totals get there by mirroring in
  // `updateUser`, which works because they accumulate -- a flow rate is absolute, so it is summed
  // here instead. A root that streams itself is part of its own sum, so this runs after the
  // per-account pass and takes precedence over that account's own rate.
  for (const [rootAccount, totalFlowRate] of flowRateByRoot) {
    const rootProfile = profileByAccount.get(rootAccount) ?? (await store.getSavedUser(rootAccount));
    if (!rootProfile) continue;
    if (await store.recordStreamFlowRate(rootProfile, totalFlowRate)) syncedRootFlowRates += 1;
  }
  inactiveAccounts = [...flowRateByAccount.values()].filter((flowRate) => flowRate === 0n).length;

  for (const stream of streams) {
    const account = stream.account.toLowerCase();
    // Falls back to the synthesized default for an account streaming for the first time, which is
    // exactly the case the sync above skips.
    const profile = profileByAccount.get(account) ?? (await store.getUser(stream.account));
    const now = new Date();
    // Closed streams are credited too, for the window between the last credit and the termination
    // -- without this the tail of every stream is silently forfeited.
    const { elapsedSeconds, gdAmountWei } = streamCreditAmount({
      now,
      lastStreamCreditAt: profile.lastStreamCreditAt,
      stream,
      previousFlowRateWeiPerSecond: previousFlowRateByAccount.get(account) ?? 0n
    });
    if (gdAmountWei === 0n) continue;
    if (elapsedSeconds < 60 * 60 * 24) {
      skippedCooldown += 1;
      continue;
    }
    if (gdAmountWei < cfg.MIN_STREAM_BONUS_WEI) {
      skippedMinAmount += 1;
      continue;
    }
    const rootAccount = await fetchGoodIdRoot(stream.account, cfg);
    const buyerForOperatorCheck = stream.buyerAddress || stream.account;
    const hasOperatorConsent = antseedFundingVault.enabled ? (await antseedFundingVault.isBuyerOperator(buyerForOperatorCheck)).isOperator : true;
    const isValidForBonus = !!rootAccount && hasOperatorConsent;

    const depositId = createStreamFundingId(stream.account, new Date(createdAt));
    const entry = await store.recordGdCredit({
      id: depositId,
      account: stream.account,
      rootAccount,
      source: "streamCron",
      gdAmountWei: BigInt(gdAmountWei),
      // The account's summed rate, not this row's: an account can hold several rows, and a closed
      // one reports 0. Also what gives a first-time streamer -- skipped by the sync above for
      // having no profile yet -- its rate on the profile this credit creates.
      flowRate: flowRateByAccount.get(account) ?? 0n,
      isVerified: isValidForBonus, // if root acccount was found it is whitelisted & operator set
      gdPrice,
      maxBonusCapUsd: cfg.MAX_BONUS_CAP_USD,
      regularBonusBps: cfg.REGULAR_BONUS_BPS,
      streamingBonusBps: cfg.STREAMING_BONUS_BPS,
      buyerAddress: stream.buyerAddress
    });
    logInfo("streamCron.credits.entry", {
      entryId: entry.id,
      account: redactAddress(entry.account),
      rootAccount: redactAddress(entry.rootAccount),
      buyer: redactAddress(entry.buyerAddress),
      elapsedSeconds,
      stream,
      entry,
      profile
    });
    processed += 1;
    ctx.waitUntil(
      fundCredit(entry, store, antseedFundingVault).then((result) => {
        if (result.fundingStatus === "funded") funded += 1;
        if (result.fundingStatus === "failed") failed += 1;
      })
    );
  }
  logInfo("cron.summary", {
    streamCount: streams.length,
    processed,
    skippedCooldown,
    skippedMinAmount,
    inactiveAccounts,
    syncedFlowRates,
    syncedRootFlowRates,
    funded,
    failed,
    elapsedMs: Date.now() - startedAt
  });
}
