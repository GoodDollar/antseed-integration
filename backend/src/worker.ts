import { z } from "zod";
import { AntSeedFundingVaultClient } from "./antseed-funding-vault.js";
import { fetchCeloVaultEvents, fetchCeloVaultEventsForAccount, fetchCurrentGdPrice, fetchGoodIdRoot } from "./celo-events.js";
import { Env, RuntimeConfig, configFromEnv } from "./env.js";
import { KVCreditStore } from "./kv-credit-store.js";
import {
  SUPERFLUID_CELO_SUBGRAPH_URL,
  StreamPeriod,
  earliestUnsettledStop,
  fetchStreamPeriods,
  liveFlowRate,
  nextBuyerWindow
} from "./stream-periods.js";
import { GdCreditEntry, UserCreditProfile } from "./types.js";
import { errorMessage, logError, logInfo, logWarn, redactAddress, redactHash } from "./logging.js";
import { getAnalyticsWindow, runAnalyticsAggregation, KVAnalyticsStore } from "./analytics.js";

const ANALYTICS_REFRESH_COOLDOWN_MS = 60 * 60 * 1000;
const ANALYTICS_REFRESH_LAST_RUN_KEY = "analytics:refresh:last-run-at";
const ANALYTICS_CRON_BACKFILL_DAYS = 40;
const ANALYTICS_CRON_BACKFILL_CURSOR_KEY = "analytics:cron:backfill-cursor";

const CeloEventsRecordSchema = z
  .object({
    txHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
    account: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    fromBlock: z
      .string()
      .regex(/^(latest|0x[0-9a-fA-F]+|\d+)$/)
      .optional(),
    toBlock: z
      .string()
      .regex(/^(latest|0x[0-9a-fA-F]+|\d+)$/)
      .optional()
  })
  .refine((value) => Boolean(value.txHash || (value.account && value.fromBlock)), {
    message: "provide txHash or account+fromBlock"
  });
const StreamUpdateSchema = z.object({
  account: z.string().min(1),
  rootAccount: z.string().min(1).optional(),
  flowRateWeiPerSecond: z.string().regex(/^\d+$/),
  monthlyGdAmountWei: z.string().regex(/^\d+$/).optional(),
  txHash: z.string().optional(),
  logIndex: z.number().int().nonnegative().optional()
});

const WithdrawPrincipalSchema = z.object({
  amount: z.string().regex(/^\d+$/),
  recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  nonce: z.string().regex(/^\d+$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/)
});
const OperatorConsentSchema = z.object({
  nonce: z.string().regex(/^\d+$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/)
});
const CreditHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  source: z.enum(["deposit", "streamUpdate", "streamRequest", "streamCron"]).optional(),
  fundingStatus: z.enum(["pending", "funded", "failed"]).optional(),
  from: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), { message: "invalid ISO timestamp" })
    .optional(),
  to: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), { message: "invalid ISO timestamp" })
    .optional()
});
const ChannelOpSchema = z.object({
  nonce: z.string().regex(/^\d+$/).optional(),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .optional()
});
const AnalyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30)
});

/** Minimum time between two credits of a live stream. */
const STREAM_CREDIT_COOLDOWN_SECONDS = 24 * 60 * 60;
/**
 * Unix seconds up to which every closed stream period is known to be settled. Periods that stopped at
 * or before it are not fetched again. Absent means 0: the first run reads every period.
 */
const STREAM_CLOSED_PERIODS_CURSOR_KEY = "streams:closed-periods-cursor";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const requestClone = request.clone();
    logInfo("request.start", {
      method: request.method,
      path: url.pathname
    });
    try {
      const response = await route(request, env, ctx);
      logInfo("request.end", {
        method: request.method,
        path: url.pathname,
        status: response.status,
        elapsedMs: Date.now() - startedAt
      });
      return response;
    } catch (err) {
      const message = errorMessage(err);
      const requestBody = await readRequestBody(requestClone);
      logError("request.error", {
        method: request.method,
        path: url.pathname,
        elapsedMs: Date.now() - startedAt,
        message
      });
      ctx.waitUntil(
        notifySlackOnRequestError(env, {
          method: request.method,
          path: `${url.pathname}${url.search}`,
          body: requestBody,
          message
        })
      );
      return json({ error: message }, 500);
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const startedAt = Date.now();
    const cfg = configFromEnv(env);
    const store = new KVCreditStore(env.ANTSEED_KV);
    const antseedFundingVault = new AntSeedFundingVaultClient(cfg);

    logInfo("cron.start", {
      bridgeEnabled: antseedFundingVault.enabled
    });

    const summary = await creditStreams(cfg, env.ANTSEED_KV, store, antseedFundingVault, ctx);
    logInfo("cron.summary", { ...summary, elapsedMs: Date.now() - startedAt });

    try {
      const summaries = await backFillAnalytics(env, ANALYTICS_CRON_BACKFILL_DAYS);
      logInfo("cron.analytics.summary", {
        runs: summaries.length,
        summaries: JSON.stringify(summaries)
      });
    } catch (error) {
      logError("cron.analytics.failed", {
        message: errorMessage(error)
      });
      ctx.waitUntil(
        notifySlackOnRequestError(env, {
          method: "SCHEDULED",
          path: "/v1/analytics/refresh",
          body: undefined,
          message: errorMessage(error)
        })
      );
    }
  }
};

async function backFillAnalytics(env: Env, maxRunsPerTick = 2) {
  const kv = env.ANTSEED_KV;
  const summaries: Array<{ currentDate: string; finalizedDates: string[] }> = [];
  const runAt = new Date();
  const todayDate = runAt.toISOString().slice(0, 10);
  let cursorDate = await readAnalyticsBackfillCursorDate(env.ANTSEED_KV);
  if (!cursorDate) {
    cursorDate = dateDaysAgo(runAt, ANALYTICS_CRON_BACKFILL_DAYS);
    await kv.put(ANALYTICS_CRON_BACKFILL_CURSOR_KEY, cursorDate);
  }
  // TODO: replace bounded loop with persisted backfill cursor when we need broader historical catch-up.
  for (let i = 0; i < maxRunsPerTick; i += 1) {
    console.log(`analytics backfill run ${i + 1} of ${maxRunsPerTick}, cursorDate=${cursorDate}`);
    const aggregationRunAt = cursorDate === todayDate ? runAt : new Date(`${cursorDate}T23:59:59.999Z`);
    const analyticsSummary = await runAnalyticsAggregation(env, aggregationRunAt);
    console.log(`analytics backfill run ${i + 1} of ${maxRunsPerTick}, cursorDate=${cursorDate} completed`, analyticsSummary);
    summaries.push({
      currentDate: analyticsSummary.currentDate,
      finalizedDates: analyticsSummary.finalizedDates
    });
    if (cursorDate === todayDate) {
      break;
    }
    const nextCursorDate = nextUtcDate(cursorDate);
    cursorDate = nextCursorDate && nextCursorDate <= todayDate ? nextCursorDate : todayDate;
    await kv.put(ANALYTICS_CRON_BACKFILL_CURSOR_KEY, cursorDate);
  }
  return summaries;
}
async function route(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const cfg = configFromEnv(env);
  const store = new KVCreditStore(env.ANTSEED_KV);
  const antseedFundingVault = new AntSeedFundingVaultClient(cfg);

  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

  if (request.method === "GET" && url.pathname === "/health") {
    return json({
      ok: true,
      service: "gooddollar-antseed-integration",
      runtime: "cloudflare-worker",
      kvEnabled: true,
      bridgeEnabled: antseedFundingVault.enabled
    });
  }

  if (request.method === "GET" && url.pathname === "/config/status") {
    return json({
      ok: true,
      service: "gooddollar-antseed-integration",
      runtime: "cloudflare-worker",
      bridge: {
        celoVaultEvents: true,
        baseBuyerOperatorEnabled: antseedFundingVault.enabled,
        mode: "celo-vault-to-base-buyer-operator"
      },
      celo: {
        rpcConfigured: Boolean(env.CELO_RPC_URL),
        vaultConfigured: Boolean(env.CELO_VAULT_ADDRESS),
        goodIdConfigured: Boolean(env.CELO_GOODID_ADDRESS),
        staticOracleConfigured: Boolean(env.CELO_STATIC_ORACLE_ADDRESS)
      },
      kvEnabled: true
    });
  }

  if (request.method === "GET" && url.pathname === "/config/values") {
    return json({
      ok: true,
      service: "gooddollar-antseed-integration",
      runtime: "cloudflare-worker",
      config: {
        GD_CUSD_PRICE: cfg.GD_CUSD_PRICE,
        MAX_BONUS_CAP_USD: cfg.MAX_BONUS_CAP_USD.toString(),
        REGULAR_BONUS_BPS: cfg.REGULAR_BONUS_BPS.toString(),
        STREAMING_BONUS_BPS: cfg.STREAMING_BONUS_BPS.toString(),
        MIN_STREAM_BONUS_WEI: cfg.MIN_STREAM_BONUS_WEI.toString(),
        CELO_VAULT_ADDRESS: cfg.CELO_VAULT_ADDRESS,
        CELO_GOODID_ADDRESS: cfg.CELO_GOODID_ADDRESS,
        CELO_STATIC_ORACLE_ADDRESS: cfg.CELO_STATIC_ORACLE_ADDRESS,
        CELO_CUSD_ADDRESS: cfg.CELO_CUSD_ADDRESS,
        CELO_GD_SUPERTOKEN_ADDRESS: cfg.CELO_GD_SUPERTOKEN_ADDRESS,
        SUPERFLUID_SUBGRAPH_URL: cfg.SUPERFLUID_SUBGRAPH_URL ?? SUPERFLUID_CELO_SUBGRAPH_URL
      }
    });
  }

  if (request.method === "GET" && url.pathname === "/v1/analytics") {
    const parsed = AnalyticsQuerySchema.safeParse({
      days: url.searchParams.get("days") ?? undefined
    });
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const analytics = await getAnalyticsWindow(env, parsed.data.days);
    return json(analytics);
  }

  if (request.method === "POST" && url.pathname === "/v1/analytics/refresh") {
    const lastRefreshAt = await readAnalyticsRefreshTimestamp(env.ANTSEED_KV);
    const now = Date.now();
    if (lastRefreshAt !== undefined && now - lastRefreshAt < ANALYTICS_REFRESH_COOLDOWN_MS) {
      const retryAfterSeconds = Math.ceil((ANALYTICS_REFRESH_COOLDOWN_MS - (now - lastRefreshAt)) / 1000);
      return json(
        {
          error: "analytics refresh is rate-limited",
          retryAfterSeconds
        },
        429
      );
    }
    await env.ANTSEED_KV.put(ANALYTICS_REFRESH_LAST_RUN_KEY, String(now));
    const summaries = await backFillAnalytics(env);
    return json(summaries);
  }

  const accountMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/profile$/);
  if (request.method === "GET" && accountMatch) {
    const account = decodeURIComponent(accountMatch[1]);
    const profile = await store.getUser(account);
    return json({ account: profile.account, profile });
  }

  const creditHistoryMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/credit-history$/);
  if (request.method === "GET" && creditHistoryMatch) {
    const account = decodeURIComponent(creditHistoryMatch[1]);
    const parsed = CreditHistoryQuerySchema.safeParse({
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
      source: url.searchParams.get("source") ?? undefined,
      fundingStatus: url.searchParams.get("fundingStatus") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined
    });
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const history = await store.getGdCreditHistory(account, parsed.data);
    return json({
      account: account.toLowerCase(),
      ...history
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/celo/events/record") {
    const body = await parseJson(request);
    const parsed = CeloEventsRecordSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    logInfo("celo.events.record.start", {
      mode: parsed.data.txHash ? "txHash" : "accountRange",
      txHash: redactHash(parsed.data.txHash),
      account: redactAddress(parsed.data.account),
      fromBlock: parsed.data.fromBlock,
      toBlock: parsed.data.toBlock ?? "latest"
    });
    const events = parsed.data.txHash
      ? await fetchCeloVaultEvents(parsed.data.txHash, cfg)
      : await fetchCeloVaultEventsForAccount(parsed.data.account!, cfg, parsed.data.fromBlock!, parsed.data.toBlock ?? "latest");
    logInfo("celo.events.record.fetched", {
      count: events.length,
      txHash: redactHash(parsed.data.txHash),
      account: redactAddress(parsed.data.account)
    });
    const recorded = [];
    const gdPrice = await fetchCurrentGdPrice(cfg);
    for (const event of events) {
      const rootAccount = await fetchGoodIdRoot(event.account, cfg);

      if (event.kind === "deposit") {
        if (event.gdAmountWei === 0n) {
          logInfo("celo.events.record.deposit.skipped.zero-amount", {
            txHash: redactHash(event.txHash),
            logIndex: event.logIndex,
            account: redactAddress(event.account)
          });
          continue;
        }
        const buyerForOperatorCheck = event.buyer || event.account;
        const hasOperatorConsent = antseedFundingVault.enabled ? (await antseedFundingVault.isBuyerOperator(buyerForOperatorCheck)).isOperator : true;
        const isValidForBonus = !!rootAccount && hasOperatorConsent;
        const depositId = `${event.txHash}:${event.logIndex}`;
        const entry = await store.recordGdCredit({
          id: depositId,
          account: event.account,
          rootAccount,
          source: "deposit",
          gdAmountWei: event.gdAmountWei,
          txHash: event.txHash,
          logIndex: event.logIndex,
          isVerified: isValidForBonus, // if root acccount was found it is whitelisted & operator set
          gdPrice,
          maxBonusCapUsd: cfg.MAX_BONUS_CAP_USD,
          regularBonusBps: cfg.REGULAR_BONUS_BPS,
          streamingBonusBps: cfg.STREAMING_BONUS_BPS,
          buyerAddress: event.buyer
        });
        logInfo("celo.events.record.entry", {
          kind: event.kind,
          entryId: entry.id,
          account: redactAddress(entry.account),
          rootAccount: redactAddress(entry.rootAccount),
          buyer: redactAddress(entry.buyerAddress)
        });
        const res = await fundCredit(entry, store, antseedFundingVault);
        recorded.push(res);
      } else {
        // Streams are credited by the scheduled run alone, from the subgraph's stream periods.
        // Crediting here too let two paths price the same window from the same stale clock under
        // different deposit ids, so both were paid. The event is still recorded, as a zero-amount
        // acknowledgement: clients wait for an entry carrying their txHash to settle. It has no
        // `streamCreditedThrough`, so it leaves the stream clock alone, and no flow rate -- the
        // scheduled run syncs that from the subgraph.
        const entry = await store.recordGdCredit({
          id: `${event.txHash}:${event.logIndex}`,
          account: event.account,
          rootAccount,
          source: "streamUpdate",
          gdAmountWei: 0n,
          txHash: event.txHash,
          logIndex: event.logIndex,
          isVerified: false,
          gdPrice,
          maxBonusCapUsd: cfg.MAX_BONUS_CAP_USD,
          regularBonusBps: cfg.REGULAR_BONUS_BPS,
          streamingBonusBps: cfg.STREAMING_BONUS_BPS,
          buyerAddress: event.buyer
        });
        logInfo("celo.events.record.stream.acknowledged", {
          entryId: entry.id,
          account: redactAddress(entry.account),
          flowRateWeiPerSecond: event.flowRateWeiPerSecond.toString(),
          reportedTotalFlowWei: event.totalFlowWei.toString()
        });
        recorded.push(await fundCredit(entry, store, antseedFundingVault));
      }
    }
    logInfo("celo.events.record.end", {
      count: recorded.length,
      txHash: redactHash(parsed.data.txHash),
      account: redactAddress(parsed.data.account)
    });
    return json({
      txHash: parsed.data.txHash,
      account: parsed.data.account?.toLowerCase(),
      fromBlock: parsed.data.fromBlock,
      toBlock: parsed.data.toBlock ?? "latest",
      events: recorded
    });
  }

  const outstandingMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/outstanding$/);
  if (request.method === "GET" && outstandingMatch) {
    const account = decodeURIComponent(outstandingMatch[1]);
    const [profile, gdCredits] = await Promise.all([store.getUser(account), store.getGdCredits(account)]);
    const outstandingFundingCredits = gdCredits.filter((entry) => entry.fundingStatus === "failed" || entry.fundingStatus === "pending");
    return json({
      account: profile.account,
      outstandingFundingUsd: profile.totalOutstandingFundingUsd,
      failedFundingCredits: outstandingFundingCredits
    });
  }

  const operatorConsentMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/operator-consent$/);
  if (request.method === "POST" && operatorConsentMatch) {
    const buyer = decodeURIComponent(operatorConsentMatch[1]).toLowerCase();
    const body = await parseJson(request);
    const parsed = OperatorConsentSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    logInfo("operator.consent.request", {
      buyer: redactAddress(buyer),
      nonce: parsed.data.nonce
    });
    const bridge = await antseedFundingVault.acceptBuyerOperator(buyer, BigInt(parsed.data.nonce), parsed.data.signature);
    logInfo("operator.consent.result", {
      buyer: redactAddress(buyer),
      enabled: bridge.enabled,
      txHash: redactHash(bridge.txHash)
    });
    return json({ buyer, bridge });
  }

  const operatorRevokeMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/operator-revoke$/);
  if (request.method === "POST" && operatorRevokeMatch) {
    const buyer = decodeURIComponent(operatorRevokeMatch[1]).toLowerCase();
    const body = await parseJson(request);
    const parsed = OperatorConsentSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    logInfo("operator.revoke.request", {
      buyer: redactAddress(buyer),
      nonce: parsed.data.nonce
    });
    const bridge = await antseedFundingVault.revokeBuyerOperator(buyer, BigInt(parsed.data.nonce), parsed.data.signature);
    logInfo("operator.revoke.result", {
      buyer: redactAddress(buyer),
      enabled: bridge.enabled,
      txHash: redactHash(bridge.txHash)
    });
    return json({ buyer, bridge });
  }

  const withdrawMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/withdraw$/);
  if (request.method === "POST" && withdrawMatch) {
    const account = decodeURIComponent(withdrawMatch[1]).toLowerCase();
    const body = await parseJson(request);
    const parsed = WithdrawPrincipalSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    logInfo("withdraw.request", {
      account: redactAddress(account),
      amountUsd: parsed.data.amount,
      recipient: redactAddress(parsed.data.recipient)
    });
    const bridge = await antseedFundingVault.withdrawPrincipalForBuyer(
      account,
      BigInt(parsed.data.amount),
      parsed.data.recipient,
      BigInt(parsed.data.nonce),
      parsed.data.signature
    );
    logInfo("withdraw.result", {
      account: redactAddress(account),
      enabled: bridge.enabled,
      txHash: redactHash(bridge.txHash)
    });
    return json({ account, amountUsd: parsed.data.amount, bridge });
  }

  const channelOpMatch = url.pathname.match(/^\/v1\/channels\/(0x[0-9a-fA-F]{64})\/(close|withdraw)$/);
  if (request.method === "POST" && channelOpMatch) {
    const channelId = channelOpMatch[1];
    const action = channelOpMatch[2];
    const body = request.headers.get("content-length") !== "0" ? await parseJson(request) : {};
    const parsed = ChannelOpSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const { nonce, signature } = parsed.data;
    logInfo("channel.request", {
      action,
      channelId: redactHash(channelId),
      hasNonce: nonce !== undefined,
      hasSignature: Boolean(signature)
    });
    const parsedNonce = nonce === undefined ? undefined : BigInt(nonce);
    const bridge =
      action === "close"
        ? await antseedFundingVault.requestClose(channelId, parsedNonce, signature)
        : await antseedFundingVault.withdrawFromChannel(channelId, parsedNonce, signature);
    logInfo("channel.result", {
      action,
      channelId: redactHash(channelId),
      enabled: bridge.enabled,
      txHash: redactHash(bridge.txHash)
    });
    return json({ channelId, action, bridge });
  }

  return json({ error: "not found" }, 404);
}

async function parseJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error("content-type must be application/json");
  return request.json();
}

async function notifySlackOnRequestError(env: Env, details: { method: string; path: string; body: string | undefined; message: string }): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) return;

  try {
    const text = [
      "Worker request exception",
      `method: ${details.method}`,
      `path: ${details.path}`,
      `body: ${formatSlackBody(details.body)}`,
      `error: ${details.message}`
    ].join("\n");

    const response = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      logWarn("slack.notify.failed", {
        status: response.status,
        path: details.path
      });
    }
  } catch (error) {
    logWarn("slack.notify.error", {
      path: details.path,
      message: errorMessage(error)
    });
  }
}

async function readRequestBody(request: Pick<Request, "text">): Promise<string | undefined> {
  try {
    const body = await request.text();
    if (!body) return undefined;
    return truncate(body, 3000);
  } catch (error) {
    return `[unavailable: ${errorMessage(error)}]`;
  }
}

function formatSlackBody(body: string | undefined): string {
  if (body === undefined) return "[empty]";
  return body;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}... [truncated]`;
}

function json(body: unknown, status = 200): Response {
  return cors(Response.json(body, { status }));
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,authorization,x-api-key,x-gooddollar-account");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * Credit every account streaming into the vault for the G$ its stream periods carried since its last
 * credit, and sync each account's recorded flow rate. The only path that credits streams.
 *
 * Each account is owed `streamOwedWei(periods, lastStreamCreditAt, asOf)`: every constant-rate period
 * times its overlap with the uncredited window. That prices rate changes, closes and re-opens exactly,
 * with no remembered rate or stream "last update" to go stale. `asOf` is the subgraph's indexed head,
 * not wall-clock time, so the window never runs past what the subgraph has seen.
 *
 * The deposit id is the window's start (`stream:<account>:<creditedThrough>`). Two runs that overlap
 * read the same clock, derive the same id and are funded once: `depositForWithId` dedupes on it.
 *
 * Live streams are gated by a 24h cooldown and `MIN_STREAM_BONUS_WEI`. An account whose streams have
 * all closed is settled in full regardless, so its final tail is paid out and the closed-periods
 * cursor can move past it.
 */
async function creditStreams(
  cfg: RuntimeConfig,
  kv: KVNamespace,
  store: KVCreditStore,
  antseedFundingVault: AntSeedFundingVaultClient,
  ctx: ExecutionContext
): Promise<Record<string, unknown>> {
  const closedAfter = await readClosedPeriodsCursor(kv);
  const snapshot = await fetchStreamPeriods(cfg, closedAfter);
  // Undefined is "subgraph unavailable", not "nothing streaming": skip, and leave the cursor alone.
  if (!snapshot) return { skipped: "subgraph_unavailable", closedAfter };
  const { asOf, periods } = snapshot;

  const periodsByAccount = new Map<string, StreamPeriod[]>();
  for (const period of periods) {
    const accountPeriods = periodsByAccount.get(period.account);
    if (accountPeriods) accountPeriods.push(period);
    else periodsByAccount.set(period.account, [period]);
  }

  const counts = {
    closedAfter,
    asOf,
    periodCount: periods.length,
    accountCount: periodsByAccount.size,
    inactiveAccounts: 0,
    syncedFlowRates: 0,
    syncedRootFlowRates: 0,
    skippedCooldown: 0,
    skippedMinAmount: 0,
    skippedUnreadableClock: 0,
    retried: 0,
    processed: 0
  };

  // Sync every account's recorded rate on every run, not only when a credit clears the gates. All
  // periods closed sums to 0, which is how the profile stops advertising a stream that has ended.
  // `getSavedUser`: the scheduled run must not create a profile as a side effect; a first-time
  // streamer gets one, with its rate, from its first credit below.
  const profileByAccount = new Map<string, UserCreditProfile>();
  const flowRateByRoot = new Map<string, bigint>();
  for (const [account, accountPeriods] of periodsByAccount) {
    const flowRate = liveFlowRate(accountPeriods);
    if (flowRate === 0n) counts.inactiveAccounts += 1;
    const profile = await store.getSavedUser(account);
    if (!profile) continue;
    if (await store.recordStreamFlowRate(profile, flowRate)) counts.syncedFlowRates += 1;
    profileByAccount.set(account, profile);
    flowRateByRoot.set(profile.rootAccount, (flowRateByRoot.get(profile.rootAccount) ?? 0n) + flowRate);
  }
  // A GoodID root's rate is the sum across its accounts (a rate is absolute, so `updateUser`'s
  // mirroring does not apply). Runs after the per-account pass so it wins for a root that streams.
  for (const [rootAccount, totalFlowRate] of flowRateByRoot) {
    const rootProfile = profileByAccount.get(rootAccount) ?? (await store.getSavedUser(rootAccount));
    if (!rootProfile) continue;
    if (await store.recordStreamFlowRate(rootProfile, totalFlowRate)) counts.syncedRootFlowRates += 1;
  }

  const gdPrice = await fetchCurrentGdPrice(cfg);
  // Bounded by the earliest closed period still owed anything, as read before this run's credits: a
  // credit made now may yet fail, so the next run has to see that period again.
  let nextCursor = asOf;
  const fundings: Promise<{ [key: string]: unknown }>[] = [];

  for (const [account, accountPeriods] of periodsByAccount) {
    const profile = profileByAccount.get(account) ?? (await store.getUser(account));
    const creditedThrough = profile.lastStreamCreditAt ? Math.floor(Date.parse(profile.lastStreamCreditAt) / 1000) : 0;
    if (!Number.isFinite(creditedThrough)) {
      logWarn("stream.credits.unreadable-clock", { account: redactAddress(account), lastStreamCreditAt: profile.lastStreamCreditAt });
      counts.skippedUnreadableClock += 1;
      const unsettled = earliestUnsettledStop(accountPeriods, 0);
      if (unsettled !== undefined) nextCursor = Math.min(nextCursor, unsettled - 1);
      continue;
    }
    const unsettled = earliestUnsettledStop(accountPeriods, creditedThrough);
    if (unsettled !== undefined) nextCursor = Math.min(nextCursor, unsettled - 1);

    // Cut the window at the first buyer change, so this entry pays exactly the buyer that was named
    // while its periods ran. The next run continues from `through` and settles the next segment.
    const window = nextBuyerWindow(accountPeriods, creditedThrough, asOf);
    if (!window) continue;
    const { buyerAddress, owedWei: gdAmountWei, through } = window;
    if (gdAmountWei === 0n) continue;
    const flowRate = liveFlowRate(accountPeriods);
    // The cooldown and the minimum hold back an open-ended window on a live stream, to avoid paying
    // out dust every run. They must not apply to a window cut short at a buyer change: that window
    // never grows, so gating it would stall the account's clock permanently and nothing after the
    // change would ever be credited. A cut window is a settlement boundary, like a close.
    if (flowRate > 0n && through === asOf) {
      if (asOf - creditedThrough < STREAM_CREDIT_COOLDOWN_SECONDS) {
        counts.skippedCooldown += 1;
        continue;
      }
      if (gdAmountWei < cfg.MIN_STREAM_BONUS_WEI) {
        counts.skippedMinAmount += 1;
        continue;
      }
    }

    const rootAccount = await fetchGoodIdRoot(account, cfg);
    const hasOperatorConsent = antseedFundingVault.enabled ? (await antseedFundingVault.isBuyerOperator(buyerAddress || account)).isOperator : true;
    // Returns the stored entry unchanged when this window's id already exists.
    let entry = await store.recordGdCredit({
      id: `stream:${account}:${creditedThrough}`,
      account,
      rootAccount,
      source: "streamCron",
      gdAmountWei,
      flowRate,
      isVerified: !!rootAccount && hasOperatorConsent, // root found => whitelisted; plus operator consent
      gdPrice,
      maxBonusCapUsd: cfg.MAX_BONUS_CAP_USD,
      regularBonusBps: cfg.REGULAR_BONUS_BPS,
      streamingBonusBps: cfg.STREAMING_BONUS_BPS,
      buyerAddress,
      // The cut point, not `asOf`: only this segment has been settled.
      streamCreditedThrough: new Date(through * 1000).toISOString()
    });
    if (entry.fundingStatus === "funded") {
      // Funded but the clock never moved (or a concurrent run just moved it): repair and move on.
      await store.advanceStreamClock(entry);
      continue;
    }
    if (entry.fundingStatus === "failed") {
      entry = await store.retryFailedFunding(entry);
      counts.retried += 1;
    }
    logInfo("streamCron.credits.entry", {
      entryId: entry.id,
      account: redactAddress(entry.account),
      rootAccount: redactAddress(entry.rootAccount),
      buyer: redactAddress(entry.buyerAddress),
      creditedThrough,
      streamCreditedThrough: entry.streamCreditedThrough,
      gdAmountWei: entry.gdAmountWei
    });
    counts.processed += 1;
    fundings.push(fundCredit(entry, store, antseedFundingVault));
  }

  if (nextCursor > closedAfter) await kv.put(STREAM_CLOSED_PERIODS_CURSOR_KEY, nextCursor.toString());
  ctx.waitUntil(
    Promise.all(fundings).then((results) => {
      logInfo("streamCron.funding.summary", {
        funded: results.filter((result) => result.fundingStatus === "funded").length,
        failed: results.filter((result) => result.fundingStatus === "failed").length
      });
    })
  );
  return { ...counts, nextCursor: Math.max(nextCursor, closedAfter) };
}

async function readClosedPeriodsCursor(kv: Pick<KVNamespace, "get">): Promise<number> {
  const raw = await kv.get(STREAM_CLOSED_PERIODS_CURSOR_KEY);
  const parsed = raw ? Number(raw) : 0;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

async function readAnalyticsRefreshTimestamp(kv: Pick<KVNamespace, "get">): Promise<number | undefined> {
  const raw = await kv.get(ANALYTICS_REFRESH_LAST_RUN_KEY);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

async function readAnalyticsBackfillCursorDate(kv: Pick<KVNamespace, "get">): Promise<string | undefined> {
  const raw = await kv.get(ANALYTICS_CRON_BACKFILL_CURSOR_KEY);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  return raw;
}

function dateDaysAgo(date: Date, days: number): string {
  const shifted = new Date(date.getTime());
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return shifted.toISOString().slice(0, 10);
}

function nextUtcDate(date: string): string | undefined {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

export async function fundCredit(
  entry: GdCreditEntry,
  store: KVCreditStore,
  antseedFundingVault: AntSeedFundingVaultClient
): Promise<{ [key: string]: unknown }> {
  const buyer = entry.buyerAddress || entry.account;
  if (entry.fundingStatus === "funded") {
    logInfo("funding.already-funded", {
      entryId: entry.id,
      source: entry.source,
      account: redactAddress(entry.account),
      buyer: redactAddress(buyer),
      fundingTxHash: redactHash(entry.fundingTxHash)
    });
    return {
      ...entry,
      bridge: {
        enabled: antseedFundingVault.enabled,
        buyer,
        amountUsd: entry.totalCreditUsd,
        txHash: entry.fundingTxHash,
        alreadyFunded: true
      }
    };
  }
  const principalUsd = BigInt(entry.principalUsd);
  const bonusUsd = BigInt(entry.bonusUsd);
  logInfo("funding.start", {
    entryId: entry.id,
    source: entry.source,
    account: redactAddress(entry.account),
    buyer: redactAddress(buyer),
    principalUsd: entry.principalUsd,
    bonusUsd: entry.bonusUsd,
    totalCreditUsd: entry.totalCreditUsd
  });
  try {
    const shouldCredit = principalUsd + bonusUsd > 0n;
    const bridge = shouldCredit
      ? await antseedFundingVault.depositForBuyerWithId(buyer, principalUsd, bonusUsd, entry.id)
      : { enabled: antseedFundingVault.enabled, buyer, amountUsd: "0" };
    if (!shouldCredit) {
      logInfo("funding.skipped.zero-amount", {
        entryId: entry.id,
        source: entry.source,
        account: redactAddress(entry.account),
        buyer: redactAddress(buyer)
      });
    } else if (!bridge.enabled) {
      logWarn("funding.bridge.disabled", {
        entryId: entry.id,
        source: entry.source,
        buyer: redactAddress(buyer)
      });
    }
    const updated = await store.markFundingResult(entry, {
      funded: true,
      txHash: bridge.txHash,
      error: undefined,
      credited: shouldCredit
    });
    logInfo("funding.success", {
      entryId: entry.id,
      source: entry.source,
      buyer: redactAddress(buyer),
      txHash: redactHash(bridge.txHash),
      bridgeEnabled: bridge.enabled
    });
    return { ...updated, bridge };
  } catch (error) {
    const message = errorMessage(error);
    logError("funding.failed", {
      entryId: entry.id,
      source: entry.source,
      account: redactAddress(entry.account),
      buyer: redactAddress(buyer),
      message
    });
    const updated = await store.markFundingResult(entry, {
      funded: false,
      error: message
    });
    return {
      ...updated,
      depositId: entry.id,
      bridge: {
        enabled: antseedFundingVault.enabled,
        buyer,
        amountUsd: entry.totalCreditUsd,
        error: message
      }
    };
  }
}
