import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { Env } from "../src/env.js";
import { encodeVaultEventLog } from "../src/celo-events.js";

class MemoryKV {
  private data = new Map<string, string>();

  async get(key: string, type?: "text" | "json") {
    const raw = this.data.get(key) ?? null;
    if (type === "json") return raw ? JSON.parse(raw) : null;
    return raw;
  }

  async put(key: string, value: string) {
    this.data.set(key, value);
  }
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    ANTSEED_KV: new MemoryKV() as never,
    ...overrides
  } as Env;
}

test("health exposes bridge status", async () => {
  const res = await worker.fetch(new Request("https://worker.test/health"), env(), {} as ExecutionContext);
  assert.equal(res.status, 200);
  const body = await res.json() as { bridgeEnabled: boolean };
  assert.equal(body.bridgeEnabled, false);
});

test("config status documents celo-to-base bridge mode", async () => {
  const res = await worker.fetch(new Request("https://worker.test/config/status"), env(), {} as ExecutionContext);
  assert.equal(res.status, 200);
  const body = await res.json() as {
    bridge: { celoVaultEvents: boolean; baseBuyerOperatorEnabled: boolean; mode: string };
  };
  assert.equal(body.bridge.celoVaultEvents, true);
  assert.equal(body.bridge.baseBuyerOperatorEnabled, false);
  assert.equal(body.bridge.mode, "celo-vault-to-base-buyer-operator");
});

test("GET /v1/accounts/:account/credit returns profile and gdCredits", async () => {
  const testEnv = env();
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${account}/credit`),
    testEnv,
    {} as ExecutionContext
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { account: string; profile: { totalGdDepositedWei: string }; gdCredits: unknown[] };
  assert.equal(body.account, account);
  assert.equal(body.profile.totalGdDepositedWei, "0");
  assert.equal(body.gdCredits.length, 0);
});

test("GET /v1/accounts/:account/outstanding returns outstanding funding info", async () => {
  const testEnv = env();
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${account}/outstanding`),
    testEnv,
    {} as ExecutionContext
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { account: string; outstandingFundingMicroUsd: string; failedFundingCredits: unknown[] };
  assert.equal(body.account, account);
  assert.equal(body.outstandingFundingMicroUsd, "0");
  assert.equal(body.failedFundingCredits.length, 0);
});

test("/v1/celo/events/record processes deposit logs and records credits", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000aaa";
  const txHash = `0x${"2".repeat(64)}`;
  const celoVault = "0x0000000000000000000000000000000000000def";

  const originalFetch = globalThis.fetch;

  try {
    const testEnv = env({ CELO_RPC_URL: "https://celo.rpc.local", CELO_VAULT_ADDRESS: celoVault });

    const depositLog = encodeVaultEventLog(
      "GdDeposited",
      [account, buyer, 2_000_000_000_000_000_000n, "0x"],
      celoVault,
      txHash,
      0
    );

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_call") {
        // GoodID root lookup — return zero address (not verified)
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: "0x0000000000000000000000000000000000000000000000000000000000000000"
        });
      }
      // eth_getLogs for tx receipt
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { logs: [depositLog] }
      });
    }) as typeof fetch;

    const res = await worker.fetch(new Request("https://worker.test/v1/celo/events/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash })
    }), testEnv, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ id: string; source: string; fundingStatus: string; principalMicroUsd: string; buyerAddress?: string }> };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].source, "deposit");
    assert.equal(body.events[0].fundingStatus, "failed");
    assert.equal(body.events[0].buyerAddress, buyer.toLowerCase());

    // Verify credit was recorded
    const creditRes = await worker.fetch(
      new Request(`https://worker.test/v1/accounts/${account}/credit`),
      testEnv,
      {} as ExecutionContext
    );
    assert.equal(creditRes.status, 200);
    const creditBody = await creditRes.json() as { gdCredits: Array<{ id: string; source: string }> };
    assert.equal(creditBody.gdCredits.length, 1);
    assert.equal(creditBody.gdCredits[0].source, "deposit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/v1/celo/events/record requires valid input", async () => {
  const testEnv = env({ CELO_RPC_URL: "https://celo.rpc.local" });

  const res = await worker.fetch(new Request("https://worker.test/v1/celo/events/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  }), testEnv, {} as ExecutionContext);
  assert.equal(res.status, 400);
});

test("POST /v1/accounts/:account/stream-credits returns no streams when none active", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const celoVault = "0x0000000000000000000000000000000000000def";
  const gdSuperToken = "0x0000000000000000000000000000000000000fed";
  const originalFetch = globalThis.fetch;

  try {
    const testEnv = env({
      CELO_RPC_URL: "https://celo.rpc.local",
      CELO_VAULT_ADDRESS: celoVault,
      CELO_GD_SUPERTOKEN_ADDRESS: gdSuperToken
    });

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.query) {
        // Superfluid subgraph query — no active streams
        return Response.json({ data: { streams: [] } });
      }
      // GoodID root lookup
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: "0x0000000000000000000000000000000000000000000000000000000000000000"
      });
    }) as typeof fetch;

    const res = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/stream-credits`, {
      method: "POST",
      headers: { "content-type": "application/json" }
    }), testEnv, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const body = await res.json() as { account: string; streams: unknown[]; message: string };
    assert.equal(body.message, "no active streams found");
    assert.equal(body.streams.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown route returns 404", async () => {
  const res = await worker.fetch(
    new Request("https://worker.test/nonexistent"),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 404);
  const body = await res.json() as { error: string };
  assert.equal(body.error, "not found");
});

test("OPTIONS returns CORS preflight", async () => {
  const res = await worker.fetch(
    new Request("https://worker.test/anything", { method: "OPTIONS" }),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("GET /v1/accounts/:account/transactions returns paginated gd credits", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000aaa";
  const txHash = `0x${"3".repeat(64)}`;
  const celoVault = "0x0000000000000000000000000000000000000def";
  const originalFetch = globalThis.fetch;

  try {
    const testEnv = env({ CELO_RPC_URL: "https://celo.rpc.local", CELO_VAULT_ADDRESS: celoVault });
    const depositLog = encodeVaultEventLog(
      "GdDeposited",
      [account, buyer, 1_000_000_000_000_000_000n, "0x"],
      celoVault,
      txHash,
      0
    );

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_call") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: "0x0000000000000000000000000000000000000000000000000000000000000000"
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { logs: [depositLog] }
      });
    }) as typeof fetch;

    await worker.fetch(new Request("https://worker.test/v1/celo/events/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash })
    }), testEnv, {} as ExecutionContext);

    const res = await worker.fetch(
      new Request(`https://worker.test/v1/accounts/${account}/transactions?limit=10`),
      testEnv,
      {} as ExecutionContext
    );
    assert.equal(res.status, 200);
    const body = await res.json() as { account: string; transactions: Array<{ source: string; fundingStatus: string }> };
    assert.equal(body.account, account);
    assert.equal(body.transactions.length, 1);
    assert.equal(body.transactions[0].source, "deposit");
    assert.equal(body.transactions[0].fundingStatus, "failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /v1/accounts/:account/withdrawable returns disabled bridge state", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${account}/withdrawable`),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { enabled: boolean; withdrawableMicroUsd: string; buyerAddress: string };
  assert.equal(body.enabled, false);
  assert.equal(body.withdrawableMicroUsd, "0");
  assert.equal(body.buyerAddress, account);
});

test("GET /v1/accounts/:account/operator returns disabled bridge state", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${account}/operator`),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { enabled: boolean; operatorAccepted: boolean; consentNonce: string };
  assert.equal(body.enabled, false);
  assert.equal(body.operatorAccepted, false);
  assert.equal(body.consentNonce, "0");
});

test("GET /v1/accounts/:account/operator/consent-payload returns 503 when bridge disabled", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${account}/operator/consent-payload`),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 503);
});

test("GET /v1/accounts/:account/status returns profile and operator summary", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${account}/status`),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 200);
  const body = await res.json() as {
    account: string;
    buyer: string | null;
    profile: { totalGdDepositedWei: string; buyer?: string };
    operator: { operatorAccepted: boolean };
    withdrawableMicroUsd: string;
  };
  assert.equal(body.account, account);
  assert.equal(body.buyer, null);
  assert.equal(body.profile.buyer, undefined);
  assert.equal(body.profile.totalGdDepositedWei, "0");
  assert.equal(body.operator.operatorAccepted, false);
  assert.equal(body.withdrawableMicroUsd, "0");
});

test("GET /v1/accounts/:account/withdraw/payload validates query params", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${account}/withdraw/payload`),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 400);
});

test("POST /v1/accounts/:account/withdraw rejects when bridge disabled", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      buyerAddress: "0x0000000000000000000000000000000000000aaa",
      amountMicroUsd: "1000000",
      recipient: "0x0000000000000000000000000000000000000bbb",
      timestamp: Math.floor(Date.now() / 1000),
      buyerSig: "0x11"
    })
  }), env(), {} as ExecutionContext);
  assert.equal(res.status, 503);
});

test("POST /v1/channels/withdraw returns bridge disabled when not configured", async () => {
  const channelId = `0x${"4".repeat(64)}`;
  const res = await worker.fetch(new Request("https://worker.test/v1/channels/withdraw", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId })
  }), env(), {} as ExecutionContext);
  assert.equal(res.status, 200);
  const body = await res.json() as { channelId: string; bridge: { enabled: boolean } };
  assert.equal(body.channelId, channelId);
  assert.equal(body.bridge.enabled, false);
});
