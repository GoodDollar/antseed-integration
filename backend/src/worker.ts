import { z } from "zod";
import { AntSeedClient, providerReceiptHash } from "./antseed-client.js";
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
    const [profile, requests, vaultBalances] = await Promise.all([
      store.getUser(account),
      store.getUserRequests(account),
      vault.balances(account)
    ]);
    return json({ account: profile.account, profile, vault: vaultBalances, requests });
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
