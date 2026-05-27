/***
 * TODO
 * 1. keep list of user deposit/stream events when calling store.recordGdCredit, so it can be returned in the API response and used by frontend to correlate with on-chain events and show correct status in UI (eg. if funding failed, frontend can show "failed to credit" status on the specific deposit/stream event instead of just showing "0 G$ available" with no explanation)
 * 2. end point for user requesting credits for their active streams (if they want to trigger funding outside of the cron or deposit events)
 * 3. implement withdraw endpoint, user can withdraw their principal from the vault if they want to stop using antseed. any unused deposited bonus will be withdrawn back to the vault.
 * 4. implement max bonus cap per rootaccount to prevent abuse (eg. if someone creates 1000 accounts and deposits 1 GD in each to get 0.2 USD bonus on each deposit, we should have a cap like max 100 USD bonus per root account or something like that)
 */
import { z } from "zod";
import { AntSeedFundingVaultClient } from "./antseed-funding-vault.js";
import { fetchCeloVaultEvents, fetchCeloVaultEventsForAccount, fetchCurrentGdMicroUsdPerToken, fetchGoodIdRoot } from "./celo-events.js";
import { Env, configFromEnv } from "./env.js";
import { KVCreditStore } from "./kv-credit-store.js";
import { GdCreditEntry } from "./types.js";

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
  amountMicroUsd: z.string().regex(/^\d+$/),
  recipient: z.string().min(1).optional()
});
const CloseChannelSchema = z.object({
  channelId: z.string().regex(/^0x[0-9a-fA-F]{64}$/)
});
const SuperfluidStreamsResponseSchema = z.object({
  data: z.object({
    streams: z.array(z.object({
      sender: z.object({ id: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }),
      currentFlowRate: z.string().regex(/^\d+$/),
      updatedAtTimestamp: z.string().regex(/^\d+$/)
    }))
  })
});

const SUPERFLUID_CELO_SUBGRAPH_URL = "https://subgraph-endpoints.superfluid.dev/celo-mainnet/protocol-v1";

type SuperfluidIncomingStream = {
  account: string;
  gdAmountWei: string;
  flowRateWeiPerSecond: string;
  lastUpdateAt: string;
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
      const depositId = createStreamFundingId(stream.account, createdAt);
      const entry = await store.recordGdCredit({
        id: depositId,
        account: stream.account,
        rootAccount,
        source: "streamCron",
        gdAmountWei: BigInt(stream.gdAmountWei),
        flowRate: BigInt(stream.flowRateWeiPerSecond),
        isVerified: !!rootAccount, // if root acccount was found it is whitelisted
        gdPrice
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
    const [profile, requests, gdCredits] = await Promise.all([
      store.getUser(account),
      store.getUserRequests(account),
      store.getGdCredits(account)
    ]);
    return json({ account: profile.account, profile, requests, gdCredits });
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
          gdPrice
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
          gdPrice
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
      outstandingStreamBonusMicroUsd: profile.totalOutstandingStreamBonusMicroUsd,
      failedFundingCredits: outstandingFundingCredits
    });
  }

  const withdrawMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/withdraw$/);
  if (request.method === "POST" && withdrawMatch) {
    const account = decodeURIComponent(withdrawMatch[1]);
    const body = await parseJson(request);
    const parsed = WithdrawSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const amount = BigInt(parsed.data.amountMicroUsd);
    const recipient = parsed.data.recipient ?? account;
    const profile = await store.withdrawPrincipal(account, amount);
    const bridge = await antseedFundingVault.withdrawDepositedFor(account, amount, recipient);
    return json({ account: profile.account, amountMicroUsd: amount.toString(), recipient, bridge });
  }

  if (request.method === "POST" && url.pathname === "/v1/channels/close") {
    const body = await parseJson(request);
    const parsed = CloseChannelSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const bridge = await antseedFundingVault.requestClose(parsed.data.channelId);
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

function createStreamFundingId(account: string, createdAt: string): string {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) {
    console.warn("invalid stream credit createdAt timestamp, falling back to current time", { account, createdAt });
  }
  return `stream:${Number.isFinite(timestamp) ? timestamp : Date.now()}:${account.toLowerCase()}`;
}

async function fundCredit(
  entry: GdCreditEntry,
  store: KVCreditStore,
  antseedFundingVault: AntSeedFundingVaultClient
): Promise<{ [key: string]: unknown }> {
  if (entry.fundingStatus === "funded") {
    throw new Error(`cannot fund credit with status ${entry.fundingStatus}`);
  }
  try {
    const bridge = await antseedFundingVault.depositForBuyerWithId(entry.account, BigInt(entry.totalCreditMicroUsd), entry.id);
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
        buyer: entry.account,
        amountMicroUsd: entry.totalCreditMicroUsd,
        error: message
      }
    };
  }
}


async function fetchSuperfluidIncomingStreams(cfg: ReturnType<typeof configFromEnv>): Promise<SuperfluidIncomingStream[]> {
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
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          query: `
            query ActiveIncomingStreams($receiver: String!, $token: String!, $first: Int!, $skip: Int!) {
              streams(
                first: $first
                skip: $skip
                where: {
                  receiver: $receiver
                  token: $token
                  currentFlowRate_gt: "0"
                }
                orderBy: updatedAtTimestamp
                orderDirection: desc
              ) {
                sender { id }
                currentFlowRate
                updatedAtTimestamp
              }
            }
          `,
          variables: {
            receiver,
            token,
            first: pageSize,
            skip
          }
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
        return {
          account: stream.sender.id.toLowerCase(),
          gdAmountWei,
          flowRateWeiPerSecond,
          lastUpdateAt
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

