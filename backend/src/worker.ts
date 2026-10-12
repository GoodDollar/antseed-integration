import { z } from "zod";
import { AntSeedFundingVaultClient } from "./antseed-funding-vault.js";
import { fetchCeloVaultEvents, fetchCeloVaultEventsForAccount, fetchCurrentGdPrice, fetchGoodIdRoot } from "./celo-events.js";
import { Env, configFromEnv } from "./env.js";
import { KVCreditStore } from "./kv-credit-store.js";
import { errorMessage, logError, logInfo, redactAddress, redactHash } from "./logging.js";
import { getAnalyticsWindow } from "./analytics.js";
import { fundCredit } from "./funding.js";
import { cors, json, notifySlackOnRequestError, parseJson, readRequestBody } from "./http.js";
import { createStreamFundingId, runStreamCreditCycle, secondsSinceLastCredit, streamCreditFromPeriods } from "./stream-credits.js";
import {
  ANALYTICS_CRON_BACKFILL_DAYS,
  ANALYTICS_REFRESH_COOLDOWN_MS,
  ANALYTICS_REFRESH_LAST_RUN_KEY,
  backFillAnalytics,
  readAnalyticsRefreshTimestamp
} from "./analytics-cron.js";
import { SUPERFLUID_CELO_SUBGRAPH_URL, StreamPeriod, fetchSuperfluidStreamsForAccount } from "./superfluid.js";
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

    await runStreamCreditCycle(cfg, store, antseedFundingVault, ctx, startedAt);

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
    /** Per-request cache: one receipt can carry several stream events for the same account. */
    const periodsByAccount = new Map<string, StreamPeriod[]>();
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
        const depositId = `${event.txHash}:${event.logIndex}`;
        // The event's `totalFlowWei` is `previousFlowRate * (now - last on-chain flow change)` -- a
        // baseline the backend does not track. It overlaps whatever the scheduled run will credit
        // from `lastStreamCreditAt`, so crediting it double-counts the overlap. Credit the window
        // the backend actually owes instead, at the rate that applied across it: the previously
        // recorded rate, since `event.flowRateWeiPerSecond` is the new one only taking effect now.
        //
        // The window is also floored at the current stream revision's creation, so a stream opening
        // after an earlier one closed cannot bill the dormant gap between them. That floor is read
        // from the subgraph rather than inferred: the cron only ever sees active streams, so it can
        // never record `flowRate = 0` on a close, and the termination event that would is pushed in
        // by `POST /v1/celo/events/record` and may never arrive. A terminated stream is absent from
        // the query (it filters on `currentFlowRate > 0`) and the floor does not apply, so the window
        // falls back to `lastStreamCreditAt` -- which can be weeks stale. The amount is therefore capped
        // at `event.totalFlowWei`: the vault computes it on-chain as what actually flowed since the
        // last flow change, so a stale clock multiplied by a remembered rate can never be credited
        // beyond the G$ the stream really carried.
        const profile = await store.getUser(event.account);
        // Lowercased: ethers hands back checksummed addresses, the subgraph lowercase ones.
        const streamCacheKey = event.account.toLowerCase();
        if (!periodsByAccount.has(streamCacheKey)) {
          const accountStreams = await fetchSuperfluidStreamsForAccount(event.account, cfg, true);
          periodsByAccount.set(
            streamCacheKey,
            accountStreams.flatMap((accountStream) => accountStream.periods)
          );
        }
        const periods = periodsByAccount.get(streamCacheKey) ?? [];
        const now = new Date();
        const gdAmountWei = streamCreditFromPeriods(now, profile.lastStreamCreditAt, periods);
        const elapsedSeconds = secondsSinceLastCredit(now, profile.lastStreamCreditAt);
        const buyerForOperatorCheck = event.buyer || event.account;
        const hasOperatorConsent =
          antseedFundingVault.enabled && gdAmountWei > 0n ? (await antseedFundingVault.isBuyerOperator(buyerForOperatorCheck)).isOperator : true;
        const isValidForBonus = !!rootAccount && hasOperatorConsent;
        const entry = await store.recordGdCredit({
          id: depositId,
          account: event.account,
          rootAccount,
          source: "streamUpdate",
          gdAmountWei,
          flowRate: event.flowRateWeiPerSecond,
          txHash: event.txHash,
          logIndex: event.logIndex,
          isVerified: isValidForBonus,
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
          buyer: redactAddress(entry.buyerAddress),
          elapsedSeconds,
          periodCount: periods.length,
          creditedGdAmountWei: gdAmountWei.toString(),
          reportedTotalFlowWei: event.totalFlowWei.toString()
        });
        const res = await fundCredit(entry, store, antseedFundingVault);
        recorded.push(res);
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

  const streamCreditsMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/stream-credits$/);
  if (request.method === "POST" && streamCreditsMatch) {
    const account = decodeURIComponent(streamCreditsMatch[1]).toLowerCase();
    const profile = await store.getUser(account);
    const rootAccount = await fetchGoodIdRoot(account, cfg);
    // Closed streams included: a user whose stream has ended is still owed the window between the
    // last credit and the termination, and the scheduled run is only every 6 hours.
    const streams = await fetchSuperfluidStreamsForAccount(account, cfg, true);

    logInfo("stream.credits.start", {
      account: redactAddress(account),
      rootAccount: redactAddress(rootAccount),
      streamCount: streams.length
    });
    if (streams.length === 0) {
      logInfo("stream.credits.empty", {
        account: redactAddress(account)
      });
      return json({ account, streams: [], message: "no streams found" });
    }

    const gdPrice = await fetchCurrentGdPrice(cfg);
    const now = new Date();
    const accountFlowRateWeiPerSecond = streams.reduce((sum, stream) => sum + BigInt(stream.flowRateWeiPerSecond), 0n);
    // One credit per account: the entry id is per account per day, and the owed amount is the sum
    // over every constant-rate period across all of this account's stream revisions.
    const accountPeriods = streams.flatMap((stream) => stream.periods);
    const elapsedSeconds = secondsSinceLastCredit(now, profile.lastStreamCreditAt);

    if (elapsedSeconds < 60 * 60 * 24) {
      // if last credit was less than 24h ago, don't issue new credits to prevent abuse and return how many seconds are left until next credit can be issued
      logInfo("stream.credits.cooldown", {
        account: redactAddress(account),
        elapsedSeconds
      });
      return json({
        account,
        streams: [],
        message: "stream credits were issued less than 60 seconds ago"
      });
    }

    const recorded = [];
    let skippedMinAmount = 0;
    {
      const buyerForOperatorCheck = streams[0]?.buyerAddress || account;
      const hasOperatorConsent = antseedFundingVault.enabled ? (await antseedFundingVault.isBuyerOperator(buyerForOperatorCheck)).isOperator : true;
      const isValidForBonus = !!rootAccount && hasOperatorConsent;
      const isVerified = isValidForBonus;
      const stream = streams[0];
      const gdAmountWei = streamCreditFromPeriods(now, profile.lastStreamCreditAt, accountPeriods);
      if (gdAmountWei <= cfg.MIN_STREAM_BONUS_WEI) {
        skippedMinAmount += 1;
        recorded.push({
          message: `stream credit amount ${gdAmountWei} is below minimum ${cfg.MIN_STREAM_BONUS_WEI}`
        });
      } else {

      const depositId = createStreamFundingId(account, now);
      const entry = await store.recordGdCredit({
        id: depositId,
        account,
        rootAccount,
        source: "streamRequest",
        gdAmountWei,
        // Summed across the account's rows for the same reason as the scheduled run.
        flowRate: accountFlowRateWeiPerSecond,
        isVerified,
        gdPrice,
        maxBonusCapUsd: cfg.MAX_BONUS_CAP_USD,
        regularBonusBps: cfg.REGULAR_BONUS_BPS,
        streamingBonusBps: cfg.STREAMING_BONUS_BPS,
        buyerAddress: stream.buyerAddress
      });

      logInfo("stream.credits.entry", {
        entryId: entry.id,
        account: redactAddress(entry.account),
        rootAccount: redactAddress(entry.rootAccount),
        buyer: redactAddress(entry.buyerAddress),
        isValidForBonus
      });
      const res = await fundCredit(entry, store, antseedFundingVault);
      recorded.push(res);
      }
    }
    if (recorded.length === 0) {
      return json({
        account,
        streams: [],
        message: "stream credits already issued today"
      });
    }
    logInfo("stream.credits.end", {
      account: redactAddress(account),
      elapsedSeconds,
      recordedCount: recorded.length,
      skippedMinAmount
    });
    return json({ account, elapsedSeconds, streams: recorded });
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




export { fundCredit };
