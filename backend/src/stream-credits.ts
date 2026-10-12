import { AntSeedFundingVaultClient } from "./antseed-funding-vault.js";
import { fetchCurrentGdPrice, fetchGoodIdRoot } from "./celo-events.js";
import { configFromEnv } from "./env.js";
import { fundCredit } from "./funding.js";
import { KVCreditStore } from "./kv-credit-store.js";
import { UserCreditProfile } from "./types.js";
import { logInfo, logWarn, redactAddress } from "./logging.js";
import { fetchSuperfluidIncomingStreams } from "./superfluid.js";
import { StreamPeriod, SuperfluidIncomingStream } from "./superfluid.js";

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
 * What a stream owes credit for between `lastStreamCreditAt` and `now`, read from Superfluid's own
 * constant-rate periods rather than reconstructed from a rate and a window.
 *
 * Each period carries one rate for its whole span, so `flowRate * overlap` is exact. Summing the
 * overlaps makes every awkward case fall out for free:
 *
 * - a rate change is two periods, each priced at its own rate, so nothing is skipped or averaged;
 * - a closed period stops at its termination, so time after a stream ended is never credited;
 * - the gap between a closed stream and its replacement has no period, so it cannot be billed;
 * - a stale `lastStreamCreditAt` cannot inflate anything, because only real periods are summed.
 *
 * With no previous credit the whole history is owed, which is correct -- it is what the stream
 * actually carried.
 */
export function streamCreditFromPeriods(now: Date, lastStreamCreditAt: string | undefined, periods: StreamPeriod[]): bigint {
  const nowMs = now.getTime();
  const lastCreditMs = lastStreamCreditAt ? Date.parse(lastStreamCreditAt) : 0;
  if (lastStreamCreditAt && !Number.isFinite(lastCreditMs)) {
    logWarn("stream.credits.unusable-baseline", { lastStreamCreditAt });
    return 0n;
  }

  let gdAmountWei = 0n;
  for (const period of periods) {
    const from = Math.max(period.startedAtMs, lastCreditMs);
    const to = Math.min(period.stoppedAtMs ?? nowMs, nowMs);
    if (to <= from) continue;
    gdAmountWei += period.flowRateWeiPerSecond * BigInt(Math.floor((to - from) / 1000));
  }
  return gdAmountWei;
}

/**
 * Seconds since the account was last credited, used only for the 24-hour cooldown. The amount owed
 * comes from the periods above; this gates how often a credit may be issued at all.
 */
export function secondsSinceLastCredit(now: Date, lastStreamCreditAt: string | undefined): number {
  if (!lastStreamCreditAt) return Number.MAX_SAFE_INTEGER;
  const lastCreditMs = Date.parse(lastStreamCreditAt);
  if (!Number.isFinite(lastCreditMs)) return 0;
  return Math.max(0, Math.floor((now.getTime() - lastCreditMs) / 1000));
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
  // Includes closed streams: their periods carry the tail of what was streamed before termination,
  // and their `currentFlowRate: 0` is how the backend learns the stream stopped.
  const streams = await fetchSuperfluidIncomingStreams(cfg);

  let syncedFlowRates = 0;
  let syncedRootFlowRates = 0;
  let skippedCooldown = 0;
  let skippedMinAmount = 0;
  let processed = 0;
  let funded = 0;
  let failed = 0;
  const createdAt = new Date().toISOString();

  // Collapse the subgraph rows to one entry per account. An account can hold several stream
  // revisions -- a closed one and its replacement -- and they are credited together, because a
  // credit entry is keyed per account per day.
  type AccountStreams = { flowRateWeiPerSecond: bigint; periods: StreamPeriod[]; buyerAddress?: string };
  const byAccount = new Map<string, AccountStreams>();
  for (const stream of streams) {
    const account = stream.account.toLowerCase();
    const current = byAccount.get(account) ?? { flowRateWeiPerSecond: 0n, periods: [] };
    current.flowRateWeiPerSecond += BigInt(stream.flowRateWeiPerSecond);
    current.periods.push(...stream.periods);
    // Rows arrive newest-first, so the first buyer seen is the most recently declared one.
    current.buyerAddress ??= stream.buyerAddress;
    byAccount.set(account, current);
  }

  // Sync each account's recorded rate before crediting, so the profile reflects reality on every
  // run rather than only when a credit clears the gates. Summed per account: a closed row reports
  // 0 and must not clobber a live replacement. All-closed sums to 0, which is how a profile stops
  // advertising a stream that no longer exists.
  //
  // `getSavedUser` rather than `getUser`: syncing corrects state that already exists, and must not
  // enrol an account that has never been credited. Its first credit creates the profile.
  const profileByAccount = new Map<string, UserCreditProfile>();
  const flowRateByRoot = new Map<string, bigint>();
  for (const [account, streamsForAccount] of byAccount) {
    const profile = await store.getSavedUser(account);
    if (!profile) continue;
    if (await store.recordStreamFlowRate(profile, streamsForAccount.flowRateWeiPerSecond)) syncedFlowRates += 1;
    profileByAccount.set(account, profile);
    flowRateByRoot.set(profile.rootAccount, (flowRateByRoot.get(profile.rootAccount) ?? 0n) + streamsForAccount.flowRateWeiPerSecond);
  }

  // A GoodID root profile aggregates its identity's wallets. The totals reach it by mirroring in
  // `updateUser`, which works because they accumulate; a flow rate is absolute, so it is summed
  // here instead. A root that streams itself is part of its own sum, so this runs second and wins.
  for (const [rootAccount, totalFlowRate] of flowRateByRoot) {
    const rootProfile = profileByAccount.get(rootAccount) ?? (await store.getSavedUser(rootAccount));
    if (!rootProfile) continue;
    if (await store.recordStreamFlowRate(rootProfile, totalFlowRate)) syncedRootFlowRates += 1;
  }
  const inactiveAccounts = [...byAccount.values()].filter((entry) => entry.flowRateWeiPerSecond === 0n).length;

  for (const [account, streamsForAccount] of byAccount) {
    // Falls back to the synthesized default for an account streaming for the first time, which is
    // exactly the case the sync above skips.
    const profile = profileByAccount.get(account) ?? (await store.getUser(account));
    const now = new Date();
    const gdAmountWei = streamCreditFromPeriods(now, profile.lastStreamCreditAt, streamsForAccount.periods);
    if (gdAmountWei === 0n) continue;

    const elapsedSeconds = secondsSinceLastCredit(now, profile.lastStreamCreditAt);
    if (elapsedSeconds < 60 * 60 * 24) {
      skippedCooldown += 1;
      continue;
    }
    if (gdAmountWei < cfg.MIN_STREAM_BONUS_WEI) {
      skippedMinAmount += 1;
      continue;
    }

    const rootAccount = await fetchGoodIdRoot(account, cfg);
    const buyerForOperatorCheck = streamsForAccount.buyerAddress || account;
    const hasOperatorConsent = antseedFundingVault.enabled ? (await antseedFundingVault.isBuyerOperator(buyerForOperatorCheck)).isOperator : true;
    const isValidForBonus = !!rootAccount && hasOperatorConsent;

    const entry = await store.recordGdCredit({
      id: createStreamFundingId(account, new Date(createdAt)),
      account,
      rootAccount,
      source: "streamCron",
      gdAmountWei,
      flowRate: streamsForAccount.flowRateWeiPerSecond,
      isVerified: isValidForBonus, // if root acccount was found it is whitelisted & operator set
      gdPrice,
      maxBonusCapUsd: cfg.MAX_BONUS_CAP_USD,
      regularBonusBps: cfg.REGULAR_BONUS_BPS,
      streamingBonusBps: cfg.STREAMING_BONUS_BPS,
      buyerAddress: streamsForAccount.buyerAddress
    });
    logInfo("streamCron.credits.entry", {
      entryId: entry.id,
      account: redactAddress(entry.account),
      rootAccount: redactAddress(entry.rootAccount),
      buyer: redactAddress(entry.buyerAddress),
      elapsedSeconds,
      periodCount: streamsForAccount.periods.length,
      gdAmountWei: gdAmountWei.toString(),
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
    accountCount: byAccount.size,
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
