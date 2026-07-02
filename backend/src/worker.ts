import { z } from "zod";
import { AntSeedFundingVaultClient } from "./antseed-funding-vault.js";
import { fetchCeloVaultEvents, fetchCeloVaultEventsForAccount, fetchCurrentGdPrice, fetchGoodIdRoot, decodeBuyerFromUserData } from "./celo-events.js";
import { Env, configFromEnv } from "./env.js";
import { KVCreditStore } from "./kv-credit-store.js";
import { GdCreditEntry } from "./types.js";
import { parseEther } from "ethers";
import { assertWithdrawTimestampFresh, buildWithdrawPrincipalPayload, recoverWithdrawPrincipalSigner } from "./withdraw-auth.js";
import { recoverSetOperatorSigner } from "./operator-auth.js";
import { quoteCreditToGd, quoteGdToCredit } from "./quote.js";
import { errorMessage, logError, logInfo, logWarn, redactAddress, redactHash } from "./logging.js";

const CeloEventsRecordSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  account: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  fromBlock: z.string().regex(/^(latest|0x[0-9a-fA-F]+|\d+)$/).optional(),
  toBlock: z.string().regex(/^(latest|0x[0-9a-fA-F]+|\d+)$/).optional()
}).refine((value) => Boolean(value.txHash || (value.account && value.fromBlock)), {
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

const WithdrawSchema = z.object({
  buyerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amountUsd: z.string().regex(/^\d+$/),
  recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  timestamp: z.number().int().nonnegative(),
  buyerSig: z.string().regex(/^0x[0-9a-fA-F]+$/)
});
const OperatorAcceptSchema = z.object({
  buyerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  buyerSig: z.string().regex(/^0x[0-9a-fA-F]+$/)
});
const addressParam = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const ChannelOpSchema = z.object({
  timestamp: z.number().int().nonnegative().optional(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).optional()
});
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
const MIN_STREAM_BONUS = parseEther("800"); // minimum G$ amount to issue a stream credit, to avoid spam and abuse

type SuperfluidIncomingStream = {
  account: string;
  flowRateWeiPerSecond: string;
  lastUpdateAt: string;
  /** AntSeed buyer decoded from the most recent FlowUpdatedEvent userdata. */
  buyerAddress?: string;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url);
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
      logError("request.error", {
        method: request.method,
        path: url.pathname,
        elapsedMs: Date.now() - startedAt,
        message
      });
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

    const gdPrice = await fetchCurrentGdPrice(cfg);
    const streams = await fetchSuperfluidIncomingStreams(cfg);
    let skippedCooldown = 0;
    let skippedMinAmount = 0;
    let processed = 0;
    let funded = 0;
    let failed = 0;
    const createdAt = new Date().toISOString();
    for (const stream of streams) {
      const profile = await store.getUser(stream.account);
      const now = new Date();
      const lastCreditMs = Date.parse(profile.lastStreamCreditAt);
      const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - lastCreditMs) / 1000));
      const gdAmountWei = BigInt(stream.flowRateWeiPerSecond) * BigInt(elapsedSeconds);
      if (elapsedSeconds < 60 * 60 * 24) {
        skippedCooldown += 1;
        continue;
      }
      if (gdAmountWei < MIN_STREAM_BONUS) {
        skippedMinAmount += 1;
        continue;
      }
      const rootAccount = await fetchGoodIdRoot(stream.account, cfg);
      const depositId = createStreamFundingId(stream.account, new Date(createdAt));
      const entry = await store.recordGdCredit({
        id: depositId,
        account: stream.account,
        rootAccount,
        source: "streamCron",
        gdAmountWei: BigInt(gdAmountWei),
        flowRate: BigInt(stream.flowRateWeiPerSecond),
        isVerified: !!rootAccount, // if root acccount was found it is whitelisted
        gdPrice,
        maxBonusCapUsd: cfg.MAX_BONUS_CAP_USD,
        buyerAddress: stream.buyerAddress
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
      funded,
      failed,
      elapsedMs: Date.now() - startedAt
    });
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
        staticOracleConfigured: Boolean(env.CELO_STATIC_ORACLE_ADDRESS)
      },
      kvEnabled: true
    });
  }

  if (request.method === "GET" && url.pathname === "/v1/quote/gd-to-credit") {
    const gdAmountWei = parseQuoteAmount(url.searchParams.get("gdAmountWei"), "gdAmountWei");
    if (typeof gdAmountWei === "string") return json({ error: gdAmountWei }, 400);
    const gdPrice = await fetchCurrentGdPrice(cfg);
    return json(quoteGdToCredit({ gdAmountWei, gdPrice }));
  }

  if (request.method === "GET" && url.pathname === "/v1/quote/credit-to-gd") {
    const creditUsd = parseQuoteAmount(url.searchParams.get("creditUsd"), "creditUsd");
    if (typeof creditUsd === "string") return json({ error: creditUsd }, 400);
    const gdPrice = await fetchCurrentGdPrice(cfg);
    return json(quoteCreditToGd({ creditUsd, gdPrice }));
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
    const [profile, gdCredits] = await Promise.all([
      store.getUser(account),
      store.getGdCredits(account),
    ]);
    const buyer = profile.buyer ?? account;
    const [operator, withdrawable] = await Promise.all([
      antseedFundingVault.getBuyerOperatorStatus(account, buyer),
      antseedFundingVault.getWithdrawablePrincipal(buyer),
    ]);
    const outstandingFundingCredits = gdCredits.filter((entry) => entry.fundingStatus === "failed" || entry.fundingStatus === "pending");
    return json({
      account,
      buyer: profile.buyer ?? null,
      profile,
      operator,
      withdrawableUsd: withdrawable.withdrawableUsd,
      outstandingFundingUsd: profile.totalOutstandingFundingUsd,
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
      const rootAccount = await fetchGoodIdRoot(account, cfg);
      await store.setBuyer(account, buyerAddress, rootAccount ?? account);
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
          maxBonusCapUsd: cfg.MAX_BONUS_CAP_USD,
          buyerAddress: event.buyer
        });
        const res = await fundCredit(entry, store, antseedFundingVault);
        logInfo("celo.events.record.entry", {
          kind: event.kind,
          entryId: entry.id,
          account: redactAddress(entry.account),
          rootAccount: redactAddress(entry.rootAccount),
          buyer: redactAddress(entry.buyerAddress),
          fundingStatus: String(res.fundingStatus)
        });
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
          maxBonusCapUsd: cfg.MAX_BONUS_CAP_USD,
          buyerAddress: event.buyer
        });
        const res = await fundCredit(entry, store, antseedFundingVault);
        logInfo("celo.events.record.entry", {
          kind: event.kind,
          entryId: entry.id,
          account: redactAddress(entry.account),
          rootAccount: redactAddress(entry.rootAccount),
          buyer: redactAddress(entry.buyerAddress),
          fundingStatus: String(res.fundingStatus)
        });
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
    const [profile, gdCredits] = await Promise.all([
      store.getUser(account),
      store.getGdCredits(account)
    ]);
    const outstandingFundingCredits = gdCredits.filter((entry) => entry.fundingStatus === "failed" || entry.fundingStatus === "pending");
    return json({
      account: profile.account,
      outstandingFundingUsd: profile.totalOutstandingFundingUsd,
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
    const amountParam = url.searchParams.get("amountUsd");
    const recipientParam = url.searchParams.get("recipient");
    if (!amountParam || !/^\d+$/.test(amountParam)) {
      return json({ error: "amountUsd query param required" }, 400);
    }
    const recipientParsed = recipientParam ? addressParam.safeParse(recipientParam) : { success: false as const };
    if (!recipientParsed.success) {
      return json({ error: "recipient query param required" }, 400);
    }
    const amountUsd = BigInt(amountParam);
    if (amountUsd <= 0n) {
      return json({ error: "amountUsd must be greater than zero" }, 400);
    }
    if (!antseedFundingVault.enabled || !antseedFundingVault.vaultAddress) {
      return json({ error: "base buyer operator bridge is not configured", account, buyerAddress }, 503);
    }
    const [chainId, withdrawable] = await Promise.all([
      antseedFundingVault.getChainId(),
      antseedFundingVault.getWithdrawablePrincipal(buyerAddress)
    ]);
    if (amountUsd > BigInt(withdrawable.withdrawableUsd)) {
      return json({
        error: "amount exceeds withdrawable principal",
        withdrawableUsd: withdrawable.withdrawableUsd
      }, 400);
    }
    const timestamp = Math.floor(Date.now() / 1000);
    return json({
      account,
      buyerAddress,
      recipient: recipientParsed.data.toLowerCase(),
      amountUsd: amountUsd.toString(),
      timestamp,
      typedData: buildWithdrawPrincipalPayload(
        chainId,
        antseedFundingVault.vaultAddress,
        buyerAddress,
        amountUsd,
        recipientParsed.data,
        timestamp
      )
    });
  }

  const streamCreditsMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/stream-credits$/);
  if (request.method === "POST" && streamCreditsMatch) {
    const account = decodeURIComponent(streamCreditsMatch[1]).toLowerCase();
    const profile = await store.getUser(account);
    const rootAccount = await fetchGoodIdRoot(account, cfg);
    const isVerified = !!rootAccount;
    const streams = await fetchSuperfluidStreamsForAccount(account, cfg);
    logInfo("stream.credits.start", {
      account: redactAddress(account),
      rootAccount: redactAddress(rootAccount),
      streamCount: streams.length,
      isVerified
    });
    if (streams.length === 0) {
      logInfo("stream.credits.empty", {
        account: redactAddress(account)
      });
      return json({ account, streams: [], message: "no active streams found" });
    }

    const gdPrice = await fetchCurrentGdPrice(cfg);
    const now = new Date();
    const lastCreditMs = Date.parse(profile.lastStreamCreditAt);
    const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - lastCreditMs) / 1000));

    if (elapsedSeconds < 60 * 60 * 24) { // if last credit was less than 24h ago, don't issue new credits to prevent abuse and return how many seconds are left until next credit can be issued
      logInfo("stream.credits.cooldown", {
        account: redactAddress(account),
        elapsedSeconds
      });
      return json({ account, streams: [], message: "stream credits were issued less than 60 seconds ago" });
    }

    const recorded = [];
    let skippedMinAmount = 0;
    for (const stream of streams) {
      const gdAmountWei = BigInt(stream.flowRateWeiPerSecond) * BigInt(elapsedSeconds);
      if (gdAmountWei <= MIN_STREAM_BONUS) {
        skippedMinAmount += 1;
        recorded.push({message: `stream credit amount ${gdAmountWei} is below minimum ${MIN_STREAM_BONUS}`});
        continue;
      }

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
        maxBonusCapUsd: cfg.MAX_BONUS_CAP_USD,
        buyerAddress: stream.buyerAddress
      });
      const res = await fundCredit(entry, store, antseedFundingVault);
      logInfo("stream.credits.entry", {
        entryId: entry.id,
        account: redactAddress(entry.account),
        buyer: redactAddress(entry.buyerAddress),
        fundingStatus: String(res.fundingStatus)
      });
      recorded.push(res);
    }
    if (recorded.length === 0) {
      return json({ account, streams: [], message: "stream credits already issued today" });
    }
    logInfo("stream.credits.end", {
      account: redactAddress(account),
      elapsedSeconds,
      recordedCount: recorded.length,
      skippedMinAmount
    });
    return json({ account, elapsedSeconds, streams: recorded });
  }

  const withdrawMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/withdraw$/);
  if (request.method === "POST" && withdrawMatch) {
    const account = decodeURIComponent(withdrawMatch[1]).toLowerCase();
    const body = await parseJson(request);
    const parsed = WithdrawSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);

    const buyerAddress = parsed.data.buyerAddress.toLowerCase();
    const recipient = parsed.data.recipient.toLowerCase();
    const amountUsd = BigInt(parsed.data.amountUsd);
    const timestamp = BigInt(parsed.data.timestamp);

    if (amountUsd <= 0n) {
      return json({ error: "amountUsd must be greater than zero" }, 400);
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
        amountUsd,
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
    if (amountUsd > BigInt(withdrawable.withdrawableUsd)) {
      return json({
        error: "amount exceeds withdrawable principal",
        withdrawableUsd: withdrawable.withdrawableUsd
      }, 400);
    }

    try {
      const bridge = await antseedFundingVault.withdrawPrincipal(
        buyerAddress,
        amountUsd,
        recipient,
        timestamp,
        parsed.data.buyerSig
      );
      return json({ account, buyerAddress, recipient, amountUsd: amountUsd.toString(), bridge });
    } catch (error) {
      const message = error instanceof Error ? error.message : "withdraw failed";
      return json({ error: message, account, buyerAddress }, 502);
    }
  }

  const channelOpMatch = url.pathname.match(/^\/v1\/channels\/(0x[0-9a-fA-F]{64})\/(close|withdraw)$/);
  if (request.method === "POST" && channelOpMatch) {
    const channelId = channelOpMatch[1];
    const action = channelOpMatch[2];
    const body = request.headers.get("content-length") !== "0" ? await parseJson(request) : {};
    const parsed = ChannelOpSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const { timestamp, signature } = parsed.data;
    logInfo("channel.request", {
      action,
      channelId: redactHash(channelId),
      hasTimestamp: timestamp !== undefined,
      hasSignature: Boolean(signature)
    });
    const bridge = action === "close"
      ? await antseedFundingVault.requestClose(channelId, timestamp, signature)
      : await antseedFundingVault.withdrawFromChannel(channelId, timestamp, signature);
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
  const day = date.toISOString().slice(0, 10);
  return `stream:${day}:${account.toLowerCase()}`;
}

function parseQuoteAmount(value: string | null, field: string): bigint | string {
  if (!value || !/^\d+$/.test(value)) return `${field} must be a non-negative integer string`;
  return BigInt(value);
}

async function fundCredit(
  entry: GdCreditEntry,
  store: KVCreditStore,
  antseedFundingVault: AntSeedFundingVaultClient
): Promise<{ [key: string]: unknown }> {
  if (entry.fundingStatus === "funded") {
    throw new Error(`cannot fund credit with status ${entry.fundingStatus}`);
  }
  const buyer = entry.buyerAddress || entry.account;
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
    const bridge = await antseedFundingVault.depositForBuyerWithId(
      buyer,
      BigInt(entry.principalUsd),
      BigInt(entry.bonusUsd),
      entry.id
    );
    if (!bridge.enabled) {
      logWarn("funding.bridge.disabled", {
        entryId: entry.id,
        source: entry.source,
        buyer: redactAddress(buyer)
      });
    }
    const updated = await store.markFundingResult(entry, { funded: true, txHash: bridge.txHash });
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
    const updated = await store.markFundingResult(entry, { funded: false, error: message });
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


async function fetchSuperfluidIncomingStreams(cfg: ReturnType<typeof configFromEnv>): Promise<SuperfluidIncomingStream[]> {
  return fetchSuperfluidStreams(cfg);
}

async function fetchSuperfluidStreamsForAccount(account: string, cfg: ReturnType<typeof configFromEnv>): Promise<SuperfluidIncomingStream[]> {
  return fetchSuperfluidStreams(cfg, account);
}

async function fetchSuperfluidStreams(cfg: ReturnType<typeof configFromEnv>, senderFilter?: string): Promise<SuperfluidIncomingStream[]> {
  if (!cfg.CELO_VAULT_ADDRESS || !cfg.CELO_GD_SUPERTOKEN_ADDRESS) {
    logWarn("superfluid.streams.skipped", {
      reason: "missing_config",
      hasVaultAddress: Boolean(cfg.CELO_VAULT_ADDRESS),
      hasSuperTokenAddress: Boolean(cfg.CELO_GD_SUPERTOKEN_ADDRESS),
      senderFilter: redactAddress(senderFilter)
    });
    return [];
  }

  const endpoint = cfg.SUPERFLUID_SUBGRAPH_URL ?? SUPERFLUID_CELO_SUBGRAPH_URL;
  const receiver = cfg.CELO_VAULT_ADDRESS.toLowerCase();
  const token = cfg.CELO_GD_SUPERTOKEN_ADDRESS.toLowerCase();
  const pageSize = 500;
  let skip = 0;
  const streams: SuperfluidIncomingStream[] = [];
  let pages = 0;

  logInfo("superfluid.streams.fetch.start", {
    endpoint,
    receiver: redactAddress(receiver),
    token: redactAddress(token),
    senderFilter: redactAddress(senderFilter)
  });

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
        const updatedAtSeconds = Number(stream.updatedAtTimestamp);
        const lastUpdateAt = Number.isFinite(updatedAtSeconds)
          ? new Date(updatedAtSeconds * 1000).toISOString()
          : new Date().toISOString();
        const rawUserData = stream.flowUpdatedEvents[0]?.userData;
        const buyerAddress = decodeBuyerFromUserData(rawUserData);
        return {
          account: stream.sender.id.toLowerCase(),
          flowRateWeiPerSecond,
          lastUpdateAt,
          buyerAddress
        };
      });

      streams.push(...batch);
      pages += 1;

      if (batch.length < pageSize) break;
      skip += pageSize;
    }
  } catch (error) {
    const message = errorMessage(error);
    logError("superfluid.streams.fetch.failed", {
      endpoint,
      receiver: redactAddress(receiver),
      token: redactAddress(token),
      senderFilter: redactAddress(senderFilter),
      message
    });
    return [];
  }

  logInfo("superfluid.streams.fetch.end", {
    endpoint,
    senderFilter: redactAddress(senderFilter),
    pages,
    count: streams.length
  });

  return streams;
}

