import { z } from "zod";
import { AntSeedFundingVaultClient } from "./antseed-funding-vault.js";
import { fetchCeloVaultEvents, fetchGoodIdRoot } from "./celo-events.js";
import { gdWeiToMicroUsd } from "./credit-bonus.js";
import { Env, configFromEnv } from "./env.js";
import { KVCreditStore } from "./kv-credit-store.js";
import { GdCreditEntry } from "./types.js";

const CeloTxSchema = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });
const ManualGdCreditSchema = z.object({
  account: z.string().min(1),
  rootAccount: z.string().min(1).optional(),
  gdAmountWei: z.string().regex(/^\d+$/),
  source: z.enum(["erc677", "erc777", "erc20", "stream", "manual"]).default("manual"),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  logIndex: z.number().int().nonnegative()
});
const StreamUpdateSchema = z.object({
  account: z.string().min(1),
  rootAccount: z.string().min(1).optional(),
  flowRateWeiPerSecond: z.string().regex(/^\d+$/),
  monthlyGdAmountWei: z.string().regex(/^\d+$/).optional(),
  txHash: z.string().optional(),
  logIndex: z.number().int().nonnegative().optional()
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(message, err);
      return json({ error: message }, 500);
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
        goodIdConfigured: Boolean(env.CELO_GOODID_ADDRESS)
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

  const requestMatch = url.pathname.match(/^\/v1\/requests\/([^/]+)$/);
  if (request.method === "GET" && requestMatch) {
    const reservation = await store.getReservation(decodeURIComponent(requestMatch[1]));
    if (!reservation) return json({ error: "request not found" }, 404);
    return json(reservation);
  }

  if (request.method === "POST" && url.pathname === "/v1/celo/events/record") {
    const auth = requireCeloEndpointAuth(request, cfg.CELO_EVENTS_API_KEY);
    if (auth) return auth;
    const body = await parseJson(request);
    const parsed = CeloTxSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);

    const events = await fetchCeloVaultEvents(parsed.data.txHash, cfg);
    const recorded = [];
    for (const event of events) {
      const rootAccount = await fetchGoodIdRoot(event.account, cfg);
      if (event.kind === "deposit") {
        const existing = await store.getGdCreditByEvent(event.txHash, event.logIndex);
        if (existing?.bridgeDepositedAt) {
          recorded.push({
            ...existing,
            bridge: {
              enabled: antseedFundingVault.enabled,
              buyer: event.account,
              amountMicroUsd: existing.totalCreditMicroUsd,
              txHash: existing.bridgeDepositTxHash,
              skipped: true,
              reason: "duplicate-event"
            }
          });
          continue;
        }
        const entry = await store.recordGdCredit({
          account: event.account,
          rootAccount,
          source: "erc677",
          gdAmountWei: event.gdAmountWei,
          principalMicroUsd: event.principalMicroUsd,
          txHash: event.txHash,
          logIndex: event.logIndex
        });
        const bridge = await bridgeCreditEntry(entry, event.account, antseedFundingVault, store);
        recorded.push({ ...entry, bridge });
      } else {
        recorded.push(await store.updateStream(
          event.account,
          rootAccount,
          event.flowRateWeiPerSecond,
          cfg.GD_MICRO_USD_PER_TOKEN,
          event.monthlyGdAmountWei,
          event.txHash,
          event.logIndex
        ));
      }
    }
    return json({ txHash: parsed.data.txHash, events: recorded });
  }

  if (request.method === "POST" && url.pathname === "/v1/celo/deposits/manual") {
    const auth = requireCeloEndpointAuth(request, cfg.CELO_EVENTS_API_KEY);
    if (auth) return auth;
    const body = await parseJson(request);
    const parsed = ManualGdCreditSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const gdAmountWei = BigInt(parsed.data.gdAmountWei);
    const principalMicroUsd = gdWeiToMicroUsd(gdAmountWei, cfg.GD_MICRO_USD_PER_TOKEN);
    const rootAccount = parsed.data.rootAccount ?? await fetchGoodIdRoot(parsed.data.account, cfg);
    const entry = await store.recordGdCredit({
      account: parsed.data.account,
      rootAccount,
      source: parsed.data.source,
      gdAmountWei,
      principalMicroUsd,
      txHash: parsed.data.txHash,
      logIndex: parsed.data.logIndex
    });
    const bridge = await bridgeCreditEntry(entry, parsed.data.account, antseedFundingVault, store);
    return json({ ...entry, bridge });
  }

  if (request.method === "POST" && url.pathname === "/v1/celo/streams/update") {
    const body = await parseJson(request);
    const parsed = StreamUpdateSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const rootAccount = parsed.data.rootAccount ?? await fetchGoodIdRoot(parsed.data.account, cfg);
    const state = await store.updateStream(
      parsed.data.account,
      rootAccount,
      BigInt(parsed.data.flowRateWeiPerSecond),
      cfg.GD_MICRO_USD_PER_TOKEN,
      parsed.data.monthlyGdAmountWei ? BigInt(parsed.data.monthlyGdAmountWei) : undefined,
      parsed.data.txHash,
      parsed.data.logIndex
    );
    return json(state);
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

function requireCeloEndpointAuth(request: Request, expectedApiKey: string | undefined): Response | undefined {
  if (!expectedApiKey) return json({ error: "celo endpoint auth not configured" }, 503);
  const providedApiKey = readApiKey(request);
  if (!providedApiKey || providedApiKey !== expectedApiKey) return json({ error: "unauthorized" }, 401);
  return undefined;
}

function readApiKey(request: Request): string | undefined {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey) return apiKey;
  const authorization = request.headers.get("authorization");
  if (!authorization) return undefined;
  const [scheme, token] = authorization.split(/\s+/);
  if (scheme?.toLowerCase() === "bearer" && token) return token;
  return undefined;
}

async function bridgeCreditEntry(
  entry: GdCreditEntry,
  account: string,
  antseedFundingVault: AntSeedFundingVaultClient,
  store: KVCreditStore
): Promise<Record<string, unknown>> {
  if (entry.bridgeDepositedAt) {
    return {
      enabled: antseedFundingVault.enabled,
      buyer: account,
      amountMicroUsd: entry.totalCreditMicroUsd,
      txHash: entry.bridgeDepositTxHash,
      skipped: true,
      reason: "duplicate-event"
    };
  }
  const bridge = await antseedFundingVault.depositForBuyer(account, BigInt(entry.totalCreditMicroUsd));
  if (bridge.txHash) await store.markGdCreditBridged(entry.id, bridge.txHash);
  return bridge;
}
