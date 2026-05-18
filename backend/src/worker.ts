import { z } from "zod";
import { AntSeedClient, providerReceiptHash } from "./antseed-client.js";
import { fetchCeloVaultEvents } from "./celo-events.js";
import { gdWeiToMicroUsd } from "./credit-bonus.js";
import { configFromEnv, Env } from "./env.js";
import { KVCreditStore } from "./kv-credit-store.js";
import { actualCostMicroUsd, estimateMaxCostMicroUsd } from "./pricing.js";
import { VaultClient } from "./vault-client.js";

const ChatSchema = z.object({
  account: z.string().min(1),
  model: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string()
  })).min(1),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  metadata: z.record(z.unknown()).optional()
});

const QuoteSchema = ChatSchema.pick({ messages: true, max_tokens: true });
const CeloTxSchema = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });
const ManualGdCreditSchema = z.object({
  account: z.string().min(1),
  gdAmountWei: z.string().regex(/^\d+$/),
  source: z.enum(["erc677", "erc777", "erc20", "stream", "manual"]).default("manual"),
  txHash: z.string().optional(),
  logIndex: z.number().int().nonnegative().optional()
});
const StreamUpdateSchema = z.object({
  account: z.string().min(1),
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
  const antseed = new AntSeedClient(cfg);
  const vault = new VaultClient(cfg);

  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "gooddollar-antseed-integration", runtime: "cloudflare-worker", kvEnabled: true, vaultEnabled: vault.enabled });
  }

  const accountMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/credit$/);
  if (request.method === "GET" && accountMatch) {
    const account = decodeURIComponent(accountMatch[1]);
    const [profile, requests, gdCredits, vaultBalances] = await Promise.all([
      store.getUser(account),
      store.getUserRequests(account),
      store.getGdCredits(account),
      vault.balances(account)
    ]);
    return json({ account: profile.account, profile, vault: vaultBalances, requests, gdCredits });
  }

  const requestMatch = url.pathname.match(/^\/v1\/requests\/([^/]+)$/);
  if (request.method === "GET" && requestMatch) {
    const reservation = await store.getReservation(decodeURIComponent(requestMatch[1]));
    if (!reservation) return json({ error: "request not found" }, 404);
    return json(reservation);
  }

  if (request.method === "POST" && url.pathname === "/v1/credits/quote") {
    const body = await parseJson(request);
    const parsed = QuoteSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const maxCostMicroUsd = estimateMaxCostMicroUsd(cfg, parsed.data.messages, parsed.data.max_tokens);
    return json({ maxCostMicroUsd: maxCostMicroUsd.toString() });
  }

  if (request.method === "POST" && url.pathname === "/v1/celo/events/record") {
    const body = await parseJson(request);
    const parsed = CeloTxSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);

    const events = await fetchCeloVaultEvents(parsed.data.txHash, cfg);
    const recorded = [];
    for (const event of events) {
      if (event.kind === "deposit") {
        recorded.push(await store.recordGdCredit({
          account: event.account,
          source: "erc677",
          gdAmountWei: event.gdAmountWei,
          principalMicroUsd: event.principalMicroUsd,
          txHash: event.txHash,
          logIndex: event.logIndex
        }));
      } else {
        recorded.push(await store.updateStream(
          event.account,
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
    const body = await parseJson(request);
    const parsed = ManualGdCreditSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const gdAmountWei = BigInt(parsed.data.gdAmountWei);
    const principalMicroUsd = gdWeiToMicroUsd(gdAmountWei, cfg.GD_MICRO_USD_PER_TOKEN);
    const entry = await store.recordGdCredit({
      account: parsed.data.account,
      source: parsed.data.source,
      gdAmountWei,
      principalMicroUsd,
      txHash: parsed.data.txHash,
      logIndex: parsed.data.logIndex
    });
    return json(entry);
  }

  if (request.method === "POST" && url.pathname === "/v1/celo/streams/update") {
    const body = await parseJson(request);
    const parsed = StreamUpdateSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const state = await store.updateStream(
      parsed.data.account,
      BigInt(parsed.data.flowRateWeiPerSecond),
      cfg.GD_MICRO_USD_PER_TOKEN,
      parsed.data.monthlyGdAmountWei ? BigInt(parsed.data.monthlyGdAmountWei) : undefined,
      parsed.data.txHash,
      parsed.data.logIndex
    );
    return json(state);
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    const body = await parseJson(request);
    const parsed = ChatSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);

    const chatRequest = parsed.data;
    const maxCostMicroUsd = estimateMaxCostMicroUsd(cfg, chatRequest.messages, chatRequest.max_tokens);
    const reservation = await store.reserve(chatRequest.account, maxCostMicroUsd);

    try {
      const vaultReserveTxHash = await vault.reserve(reservation.requestId, reservation.account, maxCostMicroUsd, chatRequest.metadata);
      await store.markVaultReserved(reservation.requestId, vaultReserveTxHash);

      const completion = await antseed.chatCompletion(chatRequest);
      const receiptHash = await providerReceiptHash(completion);
      const cost = actualCostMicroUsd(cfg, completion.usage?.prompt_tokens, completion.usage?.completion_tokens);
      const vaultSettleTxHash = await vault.settle(reservation.requestId, cost, receiptHash);
      await store.settle(reservation.requestId, cost, receiptHash, vaultSettleTxHash);

      return json({
        ...completion,
        credit: {
          requestId: reservation.requestId,
          reservedMicroUsd: maxCostMicroUsd.toString(),
          settledMicroUsd: cost.toString(),
          providerReceiptHash: receiptHash,
          vaultEnabled: vault.enabled,
          vaultReserveTxHash,
          vaultSettleTxHash
        }
      });
    } catch (err) {
      let vaultReleaseTxHash: string | undefined;
      try {
        vaultReleaseTxHash = await vault.release(reservation.requestId);
      } finally {
        await store.release(reservation.requestId, vaultReleaseTxHash);
      }
      throw err;
    }
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
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,authorization");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
