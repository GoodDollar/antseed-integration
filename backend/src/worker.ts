/***
 * TODO
 * 1. keep list of user deposit/stream events when calling store.recordGdCredit, so it can be returned in the API response and used by frontend to correlate with on-chain events and show correct status in UI (eg. if funding failed, frontend can show "failed to credit" status on the specific deposit/stream event instead of just showing "0 G$ available" with no explanation)
 * 2. end point for user requesting credits for their active streams (if they want to trigger funding outside of the cron or deposit events)
 * 3. implement max bonus cap per rootaccount to prevent abuse (eg. if someone creates 1000 accounts and deposits 1 GD in each to get 0.2 USD bonus on each deposit, we should have a cap like max 100 USD bonus per root account or something like that)
 */
import { z } from "zod";
import { AntSeedFundingVaultClient } from "./antseed-funding-vault.js";
import { fetchCeloVaultEvents, fetchCeloVaultEventsForAccount, fetchCurrentGdMicroUsdPerToken, fetchGoodIdRoot, decodeBuyerFromUserData } from "./celo-events.js";
import { Env, configFromEnv } from "./env.js";
import { KVCreditStore } from "./kv-credit-store.js";
import { GdCreditEntry } from "./types.js";
import { assertWithdrawTimestampFresh, buildWithdrawPrincipalPayload, recoverWithdrawPrincipalSigner } from "./withdraw-auth.js";
import { recoverSetOperatorSigner } from "./operator-auth.js";

const CeloEventsRecordSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  account: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  fromBlock: z.string().regex(/^(latest|0x[0-9a-fA-F]+|\d+)$/).optional(),
  toBlock: z.string().regex(/^(latest|0x[0-9a-fA-F]+|\d+)$/).optional()
}).refine((value) => Boolean(value.txHash || (value.account && value.fromBlock)), {
  message: "provide txHash or account+fromBlock"
});

const CloseChannelSchema = z.object({
  channelId: z.string().regex(/^0x[0-9a-fA-F]{64}$/)
});

const WithdrawSchema = z.object({
  buyerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amountMicroUsd: z.string().regex(/^\d+$/),
  recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  timestamp: z.number().int().nonnegative(),
  buyerSig: z.string().regex(/^0x[0-9a-fA-F]+$/)
});

const OperatorAcceptSchema = z.object({
  buyerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  buyerSig: z.string().regex(/^0x[0-9a-fA-F]+$/)
});

const addressParam = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const SuperfluidStreamsResponseSchema = z.object({
  data: z.object({
    streams: z.array(z.object({
      sender: z.object({ id: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }),
      currentFlowRate: z.string().regex(/^\d+$/),
      updatedAtTimestamp: z.string().regex(/^\d+$/),
      flowUpdatedEvents: z.array(z.object({
        userData: z.string()
      }))
    }))
  })
});

const SUPERFLUID_CELO_SUBGRAPH_URL = "https://subgraph-endpoints.superfluid.dev/celo-mainnet/protocol-v1";

type SuperfluidIncomingStream = {
  account: string;
  gdAmountWei: string;
  flowRateWeiPerSecond: string;
  lastUpdateAt: string;
  /** AntSeed buyer decoded from the most recent FlowUpdatedEvent userdata. */
  buyerAddress?: string;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(message, err);
      return json({ error: message }, 500);
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cfg = configFromEnv(env);
    const store = new KVCreditStore(env.ANTSEED_KV);
    const antseedFundingVault = new AntSeedFundingVaultClient(cfg);


    const gdPrice = await fetchCurrentGdMicroUsdPerToken(cfg);
    const streams = await fetchSuperfluidIncomingStreams(cfg);
    const createdAt = new Date().toISOString();
    for (const stream of streams) {
      const rootAccount = await fetchGoodIdRoot(stream.account, cfg);
      const depositId = createStreamFundingId(stream.account, new Date(createdAt));
      const entry = await store.recordGdCredit({
        id: depositId,
        account: stream.account,
        rootAccount,
        source: "streamCron",
        gdAmountWei: BigInt(stream.gdAmountWei),
        flowRate: BigInt(stream.flowRateWeiPerSecond),
        isVerified: !!rootAccount, // if root acccount was found it is whitelisted
        gdPrice,
        maxBonusCapMicroUsd: cfg.MAX_BONUS_CAP_MICRO_USD,
        buyerAddress: stream.buyerAddress
      });
      ctx.waitUntil(fundCredit(entry, store, antseedFundingVault));
    }
  }
}

async function route(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const cfg = configFromEnv(env);
  const store = new KVCreditStore(env.ANTSEED_KV);
  const antseedFundingVault = new AntSeedFundingVaultClient(cfg);

  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "gooddollar-antseed-integration", runtime: "cloudflare-worker", kvEnabled: true, bridgeEnabled: antseedFundingVault.enabled });
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
        reserveOracleConfigured: Boolean(env.CELO_RESERVE_PRICE_ORACLE_ADDRESS)
      },
      kvEnabled: true
    });
  }

  const accountMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/credit$/);
  if (request.method === "GET" && accountMatch) {
    const account = decodeURIComponent(accountMatch[1]);
    const [profile, gdCredits] = await Promise.all([
      store.getUser(account),
      store.getGdCredits(account)
    ]);
    return json({ account: profile.account, profile, gdCredits });
  }

  const statusMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/status$/);
  if (request.method === "GET" && statusMatch) {
    const account = decodeURIComponent(statusMatch[1]).toLowerCase();
    const buyerQuery = url.searchParams.get("buyer");
    const buyerAddress = buyerQuery && addressParam.safeParse(buyerQuery).success
      ? buyerQuery.toLowerCase()
      : account;
    const [profile, gdCredits, operator, withdrawable] = await Promise.all([
      store.getUser(account),
      store.getGdCredits(account),
      antseedFundingVault.getBuyerOperatorStatus(account, buyerAddress),
      antseedFundingVault.getWithdrawablePrincipal(buyerAddress)
    ]);
    const outstandingFundingCredits = gdCredits.filter((entry) => entry.fundingStatus === "failed" || entry.fundingStatus === "pending");
    return json({
      account,
      buyerAddress,
      profile,
      operator,
      withdrawableMicroUsd: withdrawable.withdrawableMicroUsd,
      outstandingFundingMicroUsd: profile.totalOutstandingFundingMicroUsd,
      outstandingFundingCount: outstandingFundingCredits.length
    });
  }

  const operatorConsentPayloadMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/operator\/consent-payload$/);
  if (request.method === "GET" && operatorConsentPayloadMatch) {
    const account = decodeURIComponent(operatorConsentPayloadMatch[1]).toLowerCase();
    const buyerQuery = url.searchParams.get("buyer");
    const buyerAddress = buyerQuery && addressParam.safeParse(buyerQuery).success
      ? buyerQuery.toLowerCase()
      : account;
    const payload = await antseedFundingVault.buildOperatorConsentPayload(account, buyerAddress);
    if (!payload.enabled) {
      return json({ error: "base buyer operator bridge is not configured", account, buyerAddress }, 503);
    }
    return json(payload);
  }

  const operatorAcceptMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/operator\/accept$/);
  if (request.method === "POST" && operatorAcceptMatch) {
    const account = decodeURIComponent(operatorAcceptMatch[1]).toLowerCase();
    const body = await parseJson(request);
    const parsed = OperatorAcceptSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);

    const buyerAddress = (parsed.data.buyerAddress ?? account).toLowerCase();
    if (!antseedFundingVault.enabled || !antseedFundingVault.vaultAddress) {
      return json({ error: "base buyer operator bridge is not configured", account, buyerAddress }, 503);
    }

    const operatorStatus = await antseedFundingVault.getBuyerOperatorStatus(account, buyerAddress);
    if (operatorStatus.operatorAccepted) {
      return json({ account, buyerAddress, operator: operatorStatus, message: "operator already accepted" });
    }

    const [chainId, depositsAddress, domain, nonce] = await Promise.all([
      antseedFundingVault.getChainId(),
      antseedFundingVault.getDepositsAddress(),
      antseedFundingVault.getDepositsSigningDomain(),
      antseedFundingVault.getOperatorNonce(buyerAddress)
    ]);

    let signer: string;
    try {
      signer = recoverSetOperatorSigner(
        chainId,
        depositsAddress,
        operatorStatus.operatorAddress!,
        nonce,
        parsed.data.buyerSig,
        domain
      ).toLowerCase();
    } catch {
      return json({ error: "invalid buyer signature" }, 400);
    }

    if (signer !== buyerAddress) {
      return json({ error: "buyer signature does not match buyerAddress" }, 400);
    }

    try {
      const bridge = await antseedFundingVault.acceptBuyerOperator(buyerAddress, nonce, parsed.data.buyerSig);
      const operator = await antseedFundingVault.getBuyerOperatorStatus(account, buyerAddress);
      return json({ account, buyerAddress, operator, bridge });
    } catch (error) {
      const message = error instanceof Error ? error.message : "operator accept failed";
      return json({ error: message, account, buyerAddress }, 502);
    }
  }

  const operatorMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/operator$/);
  if (request.method === "GET" && operatorMatch) {
    const account = decodeURIComponent(operatorMatch[1]).toLowerCase();
    const buyerQuery = url.searchParams.get("buyer");
    const buyerAddress = buyerQuery && addressParam.safeParse(buyerQuery).success
      ? buyerQuery.toLowerCase()
      : account;
    const operator = await antseedFundingVault.getBuyerOperatorStatus(account, buyerAddress);
    return json(operator);
  }


  if (request.method === "POST" && url.pathname === "/v1/celo/events/record") {
    const body = await parseJson(request);
    const parsed = CeloEventsRecordSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const events = parsed.data.txHash
      ? await fetchCeloVaultEvents(parsed.data.txHash, cfg)
      : await fetchCeloVaultEventsForAccount(parsed.data.account!, cfg, parsed.data.fromBlock!, parsed.data.toBlock ?? "latest");
    const recorded = [];
    const gdPrice = await fetchCurrentGdMicroUsdPerToken(cfg);
    for (const event of events) {
      const rootAccount = await fetchGoodIdRoot(event.account, cfg);
      if (event.kind === "deposit") {
        const depositId = `${event.txHash}:${event.logIndex}`;
        const entry = await store.recordGdCredit({
          id: depositId,
          account: event.account,
          rootAccount,
          source: "deposit",
          gdAmountWei: event.gdAmountWei,
          txHash: event.txHash,
          logIndex: event.logIndex,
          isVerified: !!rootAccount, // if root acccount was found it is whitelisted
          gdPrice,
          maxBonusCapMicroUsd: cfg.MAX_BONUS_CAP_MICRO_USD,
          buyerAddress: event.buyer
        });
        const res = await fundCredit(entry, store, antseedFundingVault);
        recorded.push(res);
      } else {
        const depositId = `${event.txHash}:${event.logIndex}`;
        const entry = await store.recordGdCredit({
          id: depositId,
          account: event.account,
          rootAccount,
          source: "streamUpdate",
          gdAmountWei: event.totalFlowWei,
          flowRate: event.flowRateWeiPerSecond,
          txHash: event.txHash,
          logIndex: event.logIndex,
          isVerified: !!rootAccount, // if root acccount was found it is whitelisted
          gdPrice,
          maxBonusCapMicroUsd: cfg.MAX_BONUS_CAP_MICRO_USD,
          buyerAddress: event.buyer
        });
        const res = await fundCredit(entry, store, antseedFundingVault);
        recorded.push(res);
      }
    }
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
    const [profile, gdCredits] = await Promise.all([
      store.getUser(account),
      store.getGdCredits(account)
    ]);
    const outstandingFundingCredits = gdCredits.filter((entry) => entry.fundingStatus === "failed" || entry.fundingStatus === "pending");
    return json({
      account: profile.account,
      outstandingFundingMicroUsd: profile.totalOutstandingFundingMicroUsd,
      failedFundingCredits: outstandingFundingCredits
    });
  }

  const transactionsMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/transactions$/);
  if (request.method === "GET" && transactionsMatch) {
    const account = decodeURIComponent(transactionsMatch[1]);
    const statusParam = url.searchParams.get("status");
    const statusParsed = statusParam
      ? z.enum(["pending", "funded", "failed"]).safeParse(statusParam)
      : { success: true as const, data: undefined };
    if (!statusParsed.success) {
      return json({ error: "status must be pending, funded, or failed" }, 400);
    }
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
    if (limitParam && (!Number.isFinite(limit) || limit! <= 0)) {
      return json({ error: "limit must be a positive integer" }, 400);
    }
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const page = await store.listGdCredits(account, {
      status: statusParsed.data,
      limit,
      cursor
    });
    return json({ account: account.toLowerCase(), ...page });
  }

  const withdrawableMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/withdrawable$/);
  if (request.method === "GET" && withdrawableMatch) {
    const account = decodeURIComponent(withdrawableMatch[1]).toLowerCase();
    const buyerQuery = url.searchParams.get("buyer");
    const buyerAddress = buyerQuery && addressParam.safeParse(buyerQuery).success
      ? buyerQuery.toLowerCase()
      : account;
    const result = await antseedFundingVault.getWithdrawablePrincipal(buyerAddress);
    return json({ account, buyerAddress, ...result });
  }

  const withdrawPayloadMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/withdraw\/payload$/);
  if (request.method === "GET" && withdrawPayloadMatch) {
    const account = decodeURIComponent(withdrawPayloadMatch[1]).toLowerCase();
    const buyerQuery = url.searchParams.get("buyer");
    const buyerAddress = buyerQuery && addressParam.safeParse(buyerQuery).success
      ? buyerQuery.toLowerCase()
      : account;
    const amountParam = url.searchParams.get("amountMicroUsd");
    const recipientParam = url.searchParams.get("recipient");
    if (!amountParam || !/^\d+$/.test(amountParam)) {
      return json({ error: "amountMicroUsd query param required" }, 400);
    }
    const recipientParsed = recipientParam ? addressParam.safeParse(recipientParam) : { success: false as const };
    if (!recipientParsed.success) {
      return json({ error: "recipient query param required" }, 400);
    }
    const amountMicroUsd = BigInt(amountParam);
    if (amountMicroUsd <= 0n) {
      return json({ error: "amountMicroUsd must be greater than zero" }, 400);
    }
    if (!antseedFundingVault.enabled || !antseedFundingVault.vaultAddress) {
      return json({ error: "base buyer operator bridge is not configured", account, buyerAddress }, 503);
    }
    const [chainId, withdrawable] = await Promise.all([
      antseedFundingVault.getChainId(),
      antseedFundingVault.getWithdrawablePrincipal(buyerAddress)
    ]);
    if (amountMicroUsd > BigInt(withdrawable.withdrawableMicroUsd)) {
      return json({
        error: "amount exceeds withdrawable principal",
        withdrawableMicroUsd: withdrawable.withdrawableMicroUsd
      }, 400);
    }
    const timestamp = Math.floor(Date.now() / 1000);
    return json({
      account,
      buyerAddress,
      recipient: recipientParsed.data.toLowerCase(),
      amountMicroUsd: amountMicroUsd.toString(),
      timestamp,
      typedData: buildWithdrawPrincipalPayload(
        chainId,
        antseedFundingVault.vaultAddress,
        buyerAddress,
        amountMicroUsd,
        recipientParsed.data,
        timestamp
      )
    });
  }

  const withdrawMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/withdraw$/);
  if (request.method === "POST" && withdrawMatch) {
    const account = decodeURIComponent(withdrawMatch[1]).toLowerCase();
    const body = await parseJson(request);
    const parsed = WithdrawSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);

    const buyerAddress = parsed.data.buyerAddress.toLowerCase();
    const recipient = parsed.data.recipient.toLowerCase();
    const amountMicroUsd = BigInt(parsed.data.amountMicroUsd);
    const timestamp = BigInt(parsed.data.timestamp);

    if (amountMicroUsd <= 0n) {
      return json({ error: "amountMicroUsd must be greater than zero" }, 400);
    }

    try {
      assertWithdrawTimestampFresh(parsed.data.timestamp);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid withdraw timestamp";
      return json({ error: message }, 400);
    }

    if (!antseedFundingVault.enabled || !antseedFundingVault.vaultAddress) {
      return json({ error: "base buyer operator bridge is not configured", account, buyerAddress }, 503);
    }

    let signer: string;
    try {
      const chainId = await antseedFundingVault.getChainId();
      signer = recoverWithdrawPrincipalSigner(
        chainId,
        antseedFundingVault.vaultAddress,
        buyerAddress,
        amountMicroUsd,
        recipient,
        timestamp,
        parsed.data.buyerSig
      ).toLowerCase();
    } catch {
      return json({ error: "invalid buyer signature" }, 400);
    }

    if (signer !== buyerAddress) {
      return json({ error: "buyer signature does not match buyerAddress" }, 400);
    }

    const withdrawable = await antseedFundingVault.getWithdrawablePrincipal(buyerAddress);
    if (!withdrawable.enabled) {
      return json({ error: "base buyer operator bridge is not configured", account, buyerAddress }, 503);
    }
    if (amountMicroUsd > BigInt(withdrawable.withdrawableMicroUsd)) {
      return json({
        error: "amount exceeds withdrawable principal",
        withdrawableMicroUsd: withdrawable.withdrawableMicroUsd
      }, 400);
    }

    try {
      const bridge = await antseedFundingVault.withdrawPrincipal(
        buyerAddress,
        amountMicroUsd,
        recipient,
        timestamp,
        parsed.data.buyerSig
      );
      return json({ account, buyerAddress, recipient, amountMicroUsd: amountMicroUsd.toString(), bridge });
    } catch (error) {
      const message = error instanceof Error ? error.message : "withdraw failed";
      return json({ error: message, account, buyerAddress }, 502);
    }
  }

  const streamCreditsMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/stream-credits$/);
  if (request.method === "POST" && streamCreditsMatch) {
    const account = decodeURIComponent(streamCreditsMatch[1]).toLowerCase();
    const profile = await store.getUser(account);
    const rootAccount = await fetchGoodIdRoot(account, cfg);
    const isVerified = !!rootAccount;
    const streams = await fetchSuperfluidStreamsForAccount(account, cfg);
    if (streams.length === 0) {
      return json({ account, streams: [], message: "no active streams found" });
    }

    const gdPrice = await fetchCurrentGdMicroUsdPerToken(cfg);
    const now = new Date();
    const lastCreditMs = Date.parse(profile.lastStreamCreditAt);
    const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - lastCreditMs) / 1000));

    if (elapsedSeconds < 60 * 60 * 24) { // if last credit was less than 24h ago, don't issue new credits to prevent abuse and return how many seconds are left until next credit can be issued
      return json({ account, streams: [], message: "stream credits were issued less than 60 seconds ago" });
    }

    const recorded = [];
    for (const stream of streams) {
      const gdAmountWei = BigInt(stream.flowRateWeiPerSecond) * BigInt(elapsedSeconds);
      if (gdAmountWei <= 0n) continue;

      const depositId = createStreamFundingId(account, now);
      const entry = await store.recordGdCredit({
        id: depositId,
        account,
        rootAccount,
        source: "streamRequest",
        gdAmountWei,
        flowRate: BigInt(stream.flowRateWeiPerSecond),
        isVerified,
        gdPrice,
        maxBonusCapMicroUsd: cfg.MAX_BONUS_CAP_MICRO_USD,
        buyerAddress: stream.buyerAddress
      });
      const res = await fundCredit(entry, store, antseedFundingVault);
      recorded.push(res);
    }
    if (recorded.length === 0) {
      return json({ account, streams: [], message: "stream credits already issued today" });
    }
    return json({ account, elapsedSeconds, streams: recorded });
  }

  if (request.method === "POST" && url.pathname === "/v1/channels/close") {
    const body = await parseJson(request);
    const parsed = CloseChannelSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const bridge = await antseedFundingVault.requestClose(parsed.data.channelId);
    return json({ channelId: parsed.data.channelId, bridge });
  }

  if (request.method === "POST" && url.pathname === "/v1/channels/withdraw") {
    const body = await parseJson(request);
    const parsed = CloseChannelSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const bridge = await antseedFundingVault.withdrawChannel(parsed.data.channelId);
    return json({ channelId: parsed.data.channelId, bridge });
  }

  return json({ error: "not found" }, 404);
}

async function parseJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error("content-type must be application/json");
  return request.json();
}

function json(body: unknown, status = 200): Response {
  return cors(Response.json(body, { status }));
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,authorization,x-api-key,x-gooddollar-account");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function createStreamFundingId(account: string, date: Date): string {
  const day = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return `stream:${day}:${account.toLowerCase()}`;
}

async function fundCredit(
  entry: GdCreditEntry,
  store: KVCreditStore,
  antseedFundingVault: AntSeedFundingVaultClient
): Promise<{ [key: string]: unknown }> {
  if (entry.fundingStatus === "funded") {
    return { ...entry, bridge: { enabled: antseedFundingVault.enabled, skipped: true } };
  }
  const buyer = entry.buyerAddress || entry.account;
  try {
    const bridge = await antseedFundingVault.depositForBuyerWithId(
      buyer,
      BigInt(entry.principalMicroUsd),
      BigInt(entry.bonusMicroUsd),
      entry.id
    );
    if (!bridge.enabled) {
      const updated = await store.markFundingResult(entry, { funded: false, error: "bridge not configured" });
      return {
        ...updated,
        bridge: {
          enabled: false,
          buyer,
          amountMicroUsd: entry.totalCreditMicroUsd,
          error: "bridge not configured"
        }
      };
    }
    const updated = await store.markFundingResult(entry, { funded: true, txHash: bridge.txHash });
    return { ...updated, bridge };
  } catch (error) {
    const message = error instanceof Error ? error.message : "deposit funding failed";
    console.error("stream/deferred funding failed", { account: entry.account, entryId: entry.id, message });
    const updated = await store.markFundingResult(entry, { funded: false, error: message });
    return {
      ...updated,
      depositId: entry.id,
      bridge: {
        enabled: antseedFundingVault.enabled,
        buyer,
        amountMicroUsd: entry.totalCreditMicroUsd,
        error: message
      }
    };
  }
}


async function fetchSuperfluidIncomingStreams(cfg: ReturnType<typeof configFromEnv>): Promise<SuperfluidIncomingStream[]> {
  return fetchSuperfluidStreams(cfg);
}

async function fetchSuperfluidStreamsForAccount(account: string, cfg: ReturnType<typeof configFromEnv>): Promise<SuperfluidIncomingStream[]> {
  return fetchSuperfluidStreams(cfg, account);
}

async function fetchSuperfluidStreams(cfg: ReturnType<typeof configFromEnv>, senderFilter?: string): Promise<SuperfluidIncomingStream[]> {
  if (!cfg.CELO_VAULT_ADDRESS || !cfg.CELO_GD_SUPERTOKEN_ADDRESS) {
    return [];
  }

  const endpoint = cfg.SUPERFLUID_SUBGRAPH_URL ?? SUPERFLUID_CELO_SUBGRAPH_URL;
  const receiver = cfg.CELO_VAULT_ADDRESS.toLowerCase();
  const token = cfg.CELO_GD_SUPERTOKEN_ADDRESS.toLowerCase();
  const pageSize = 500;
  let skip = 0;
  const streams: SuperfluidIncomingStream[] = [];

  try {
    while (true) {
      const whereClause = senderFilter
        ? `{ receiver: $receiver, token: $token, currentFlowRate_gt: "0", sender: $sender }`
        : `{ receiver: $receiver, token: $token, currentFlowRate_gt: "0" }`;
      const queryParams = senderFilter
        ? `$receiver: String!, $token: String!, $first: Int!, $skip: Int!, $sender: String!`
        : `$receiver: String!, $token: String!, $first: Int!, $skip: Int!`;
      const variables: Record<string, unknown> = { receiver, token, first: pageSize, skip };
      if (senderFilter) variables.sender = senderFilter.toLowerCase();

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          query: `
            query ActiveIncomingStreams(${queryParams}) {
              streams(
                first: $first
                skip: $skip
                where: ${whereClause}
                orderBy: updatedAtTimestamp
                orderDirection: desc
              ) {
                sender { id }
                currentFlowRate
                updatedAtTimestamp
                flowUpdatedEvents(orderBy: timestamp, orderDirection: desc, first: 1) {
                  userData
                }
              }
            }
          `,
          variables
        })
      });

      if (!response.ok) {
        throw new Error(`Superfluid subgraph HTTP ${response.status}`);
      }

      const body = await response.json();
      const parsed = SuperfluidStreamsResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error("invalid Superfluid subgraph response shape");
      }

      const batch = parsed.data.data.streams.map((stream) => {
        const flowRateWeiPerSecond = stream.currentFlowRate;
        const gdAmountWei = (BigInt(flowRateWeiPerSecond) * 60n).toString();
        const updatedAtSeconds = Number(stream.updatedAtTimestamp);
        const lastUpdateAt = Number.isFinite(updatedAtSeconds)
          ? new Date(updatedAtSeconds * 1000).toISOString()
          : new Date().toISOString();
        const rawUserData = stream.flowUpdatedEvents[0]?.userData;
        const buyerAddress = decodeBuyerFromUserData(rawUserData);
        return {
          account: stream.sender.id.toLowerCase(),
          gdAmountWei,
          flowRateWeiPerSecond,
          lastUpdateAt,
          buyerAddress
        };
      });

      streams.push(...batch);

      if (batch.length < pageSize) break;
      skip += pageSize;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown Superfluid stream fetch error";
    console.error("failed fetching incoming Superfluid streams", {
      endpoint,
      receiver,
      token,
      message
    });
    return [];
  }

  return streams;
}

