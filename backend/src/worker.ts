import { z } from "zod";
import { AntSeedFundingVaultClient } from "./antseed-funding-vault.js";
import { fetchCeloVaultEvents, fetchCeloVaultEventsForAccount, fetchCurrentGdPrice, fetchGoodIdRoot, decodeBuyerFromUserData } from "./celo-events.js";
import { Env, configFromEnv } from "./env.js";
import { KVCreditStore } from "./kv-credit-store.js";
import { GdCreditEntry } from "./types.js";
import { parseEther } from "ethers";
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

const WithdrawPrincipalSchema = z.object({
  amount: z.string().regex(/^\d+$/),
  recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  timestamp: z.number().int().nonnegative(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/)
});
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

  const accountMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/credit$/);
  if (request.method === "GET" && accountMatch) {
    const account = decodeURIComponent(accountMatch[1]);
    const [profile, gdCredits] = await Promise.all([
      store.getUser(account),
      store.getGdCredits(account)
    ]);
    return json({ account: profile.account, profile, gdCredits });
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
      parsed.data.timestamp,
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
  const day = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return `stream:${day}:${account.toLowerCase()}`;
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

