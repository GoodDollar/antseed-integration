import { z } from "zod";
import { AntSeedFundingVaultClient } from "./antseed-funding-vault.js";
import { fetchCeloVaultEvents, fetchCeloVaultEventsForAccount, fetchGoodIdRoot } from "./celo-events.js";
import { Env, configFromEnv } from "./env.js";
import { KVCreditStore } from "./kv-credit-store.js";

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
    const streams = await store.listTrackedStreams();
    for (const stream of streams) {
      if (!stream.active) continue;
      const credit = await store.settleDueStreamBonus(stream.account, new Date());
      if (!credit) continue;
      ctx.waitUntil(fundCredit(credit, store, antseedFundingVault, createStreamFundingId(credit.account, credit.createdAt)));
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
    const body = await parseJson(request);
    const parsed = CeloEventsRecordSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const events = parsed.data.txHash
      ? await fetchCeloVaultEvents(parsed.data.txHash, cfg)
      : await fetchCeloVaultEventsForAccount(parsed.data.account!, cfg, parsed.data.fromBlock!, parsed.data.toBlock ?? "latest");
    const recorded = [];
    for (const event of events) {
      const rootAccount = await fetchGoodIdRoot(event.account, cfg);
      if (event.kind === "deposit") {
        const entry = await store.recordGdCredit({
          account: event.account,
          rootAccount,
          source: "erc677",
          gdAmountWei: event.gdAmountWei,
          principalMicroUsd: event.principalMicroUsd,
          txHash: event.txHash,
          logIndex: event.logIndex
        });
        const depositId = createDepositFundingId(event.txHash, event.logIndex, "event");
        try {
          const bridge = await antseedFundingVault.depositForBuyerWithId(event.account, BigInt(entry.totalCreditMicroUsd), depositId);
          const updated = await store.markFundingResult(entry.id, { funded: true, id: depositId, txHash: bridge.txHash });
          recorded.push({ ...updated, bridge, depositId });
        } catch (error) {
          const message = error instanceof Error ? error.message : "deposit funding failed";
          const updated = await store.markFundingResult(entry.id, { funded: false, id: depositId, error: message });
          recorded.push({ ...updated, bridge: { enabled: antseedFundingVault.enabled, buyer: event.account, amountMicroUsd: entry.totalCreditMicroUsd, error: message }, depositId });
        }
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
    return json({
      txHash: parsed.data.txHash,
      account: parsed.data.account?.toLowerCase(),
      fromBlock: parsed.data.fromBlock,
      toBlock: parsed.data.toBlock ?? "latest",
      events: recorded
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/celo/streams/update") {
    const body = await parseJson(request);
    const parsed = StreamUpdateSchema.safeParse(body);
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const rootAccount = parsed.data.rootAccount ?? await fetchGoodIdRoot(parsed.data.account, cfg);
    const settled = await store.settleStreamBonusOnFlowChange(
      parsed.data.account,
      BigInt(parsed.data.flowRateWeiPerSecond),
      parsed.data.txHash,
      parsed.data.logIndex
    );
    if (settled) {
      await fundCredit(settled, store, antseedFundingVault, createStreamFundingId(settled.account, settled.createdAt));
    }
    const state = await store.updateStream(
      parsed.data.account,
      rootAccount,
      BigInt(parsed.data.flowRateWeiPerSecond),
      cfg.GD_MICRO_USD_PER_TOKEN,
      parsed.data.monthlyGdAmountWei ? BigInt(parsed.data.monthlyGdAmountWei) : undefined,
      parsed.data.txHash,
      parsed.data.logIndex
    );
    return json({ ...state, settledStreamBonusCreditId: settled?.id });
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

function createDepositFundingId(txHash: string | undefined, logIndex: number | undefined, prefix: string): string {
  if (txHash && logIndex !== undefined && logIndex !== null) return `${txHash}:${logIndex}`;
  return `${prefix}:${Date.now()}`;
}

function createStreamFundingId(account: string, createdAt: string): string {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) {
    console.warn("invalid stream credit createdAt timestamp, falling back to current time", { account, createdAt });
  }
  return `stream:${Number.isFinite(timestamp) ? timestamp : Date.now()}:${account.toLowerCase()}`;
}

async function fundCredit(
  entry: { id: string; account: string; totalCreditMicroUsd: string },
  store: KVCreditStore,
  antseedFundingVault: AntSeedFundingVaultClient,
  fundingId: string
): Promise<void> {
  try {
    const bridge = await antseedFundingVault.depositForBuyerWithId(entry.account, BigInt(entry.totalCreditMicroUsd), fundingId);
    await store.markFundingResult(entry.id, { funded: true, id: fundingId, txHash: bridge.txHash });
  } catch (error) {
    const message = error instanceof Error ? error.message : "deposit funding failed";
    console.error("stream/deferred funding failed", { account: entry.account, entryId: entry.id, fundingId, message });
    await store.markFundingResult(entry.id, { funded: false, id: fundingId, error: message });
  }
}
