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
  const body = (await res.json()) as { bridgeEnabled: boolean };
  assert.equal(body.bridgeEnabled, false);
});

test("config status documents celo-to-base bridge mode", async () => {
  const res = await worker.fetch(new Request("https://worker.test/config/status"), env(), {} as ExecutionContext);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    bridge: { celoVaultEvents: boolean; baseBuyerOperatorEnabled: boolean; mode: string };
  };
  assert.equal(body.bridge.celoVaultEvents, true);
  assert.equal(body.bridge.baseBuyerOperatorEnabled, false);
  assert.equal(body.bridge.mode, "celo-vault-to-base-buyer-operator");
});

test("config values exposes non-secret runtime constants", async () => {
  const res = await worker.fetch(new Request("https://worker.test/config/values"), env(), {} as ExecutionContext);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    config: {
      GD_CUSD_PRICE: number;
      MAX_BONUS_CAP_USD: string;
      REGULAR_BONUS_BPS: string;
      STREAMING_BONUS_BPS: string;
      MIN_STREAM_BONUS_WEI: string;
    };
  };
  assert.equal(body.config.GD_CUSD_PRICE, 0.0001);
  assert.equal(body.config.MAX_BONUS_CAP_USD, "100000000000000000000");
  assert.equal(body.config.REGULAR_BONUS_BPS, "1000");
  assert.equal(body.config.STREAMING_BONUS_BPS, "2000");
  assert.equal(body.config.MIN_STREAM_BONUS_WEI, "4000000000000000000000");
});

test("GET /v1/accounts/:account/profile returns profile only", async () => {
  const testEnv = env();
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/profile`), testEnv, {} as ExecutionContext);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { account: string; profile: { totalGdDepositedWei: string }; gdCredits?: unknown };
  assert.equal(body.account, account);
  assert.equal(body.profile.totalGdDepositedWei, "0");
  assert.equal(body.gdCredits, undefined);
});

test("GET /v1/accounts/:account/credit-history returns paginated empty history", async () => {
  const testEnv = env();
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/credit-history`), testEnv, {} as ExecutionContext);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    account: string;
    items: unknown[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  assert.equal(body.account, account);
  assert.equal(body.items.length, 0);
  assert.equal(body.total, 0);
  assert.equal(body.limit, 20);
  assert.equal(body.offset, 0);
  assert.equal(body.hasMore, false);
});

test("GET /v1/accounts/:account/credit-history returns 400 on invalid query", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${account}/credit-history?source=not-a-source`),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 400);
});

test("GET /v1/accounts/:account/outstanding returns outstanding funding info", async () => {
  const testEnv = env();
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/outstanding`), testEnv, {} as ExecutionContext);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { account: string; outstandingFundingUsd: string; failedFundingCredits: unknown[] };
  assert.equal(body.account, account);
  assert.equal(body.outstandingFundingUsd, "0");
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

    const depositLog = encodeVaultEventLog("GdDeposited", [account, buyer, 2_000_000_000_000_000_000n, "0x"], celoVault, txHash, 0);

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

    const res = await worker.fetch(
      new Request("https://worker.test/v1/celo/events/record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash })
      }),
      testEnv,
      {} as ExecutionContext
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { events: Array<{ id: string; source: string; fundingStatus: string; principalUsd: string; buyerAddress?: string }> };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].source, "deposit");
    assert.equal(body.events[0].fundingStatus, "funded");
    assert.equal(body.events[0].buyerAddress, buyer.toLowerCase());

    // Verify credit was recorded
    const creditRes = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/profile`), testEnv, {} as ExecutionContext);
    assert.equal(creditRes.status, 200);
    const creditBody = (await creditRes.json()) as { profile: { totalGdDepositedWei: string }; gdCredits?: unknown };
    assert.equal(creditBody.gdCredits, undefined);
    assert.notEqual(creditBody.profile.totalGdDepositedWei, "0");

    const historyRes = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/credit-history`), testEnv, {} as ExecutionContext);
    assert.equal(historyRes.status, 200);
    const historyBody = (await historyRes.json()) as { items: Array<{ id: string; source: string }> };
    assert.equal(historyBody.items.length, 1);
    assert.equal(historyBody.items[0].source, "deposit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/v1/celo/events/record requires valid input", async () => {
  const testEnv = env({ CELO_RPC_URL: "https://celo.rpc.local" });

  const res = await worker.fetch(
    new Request("https://worker.test/v1/celo/events/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    }),
    testEnv,
    {} as ExecutionContext
  );
  assert.equal(res.status, 400);
});

test("request exceptions send slack webhook with path, body, and error", async () => {
  const originalFetch = globalThis.fetch;
  const webhookCalls: Array<{ url: string; body: { text: string } }> = [];
  const pending: Array<Promise<unknown>> = [];

  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      webhookCalls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as { text: string }
      });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const testEnv = env({ SLACK_WEBHOOK_URL: "https://hooks.slack.test/services/example" });
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {}
    } as unknown as ExecutionContext;
    const res = await worker.fetch(
      new Request("https://worker.test/v1/celo/events/record?source=test", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ txHash: `0x${"2".repeat(64)}` })
      }),
      testEnv,
      ctx
    );

    await Promise.all(pending);

    assert.equal(res.status, 500);
    assert.equal(webhookCalls.length, 1);
    assert.equal(webhookCalls[0].url, "https://hooks.slack.test/services/example");
    assert.match(webhookCalls[0].body.text, /path: \/v1\/celo\/events\/record\?source=test/);
    assert.match(webhookCalls[0].body.text, /body: \{"txHash":"0x2222/);
    assert.match(webhookCalls[0].body.text, /error: content-type must be application\/json/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

    const res = await worker.fetch(
      new Request(`https://worker.test/v1/accounts/${account}/stream-credits`, {
        method: "POST",
        headers: { "content-type": "application/json" }
      }),
      testEnv,
      {} as ExecutionContext
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { account: string; streams: unknown[]; message: string };
    assert.equal(body.message, "no active streams found");
    assert.equal(body.streams.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown route returns 404", async () => {
  const res = await worker.fetch(new Request("https://worker.test/nonexistent"), env(), {} as ExecutionContext);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "not found");
});

test("OPTIONS returns CORS preflight", async () => {
  const res = await worker.fetch(new Request("https://worker.test/anything", { method: "OPTIONS" }), env(), {} as ExecutionContext);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

const CHANNEL_ID = `0x${"a".repeat(64)}`;

test("POST /v1/channels/:channelId/close returns enabled:false when vault not configured", async () => {
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/channels/${CHANNEL_ID}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    }),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { channelId: string; action: string; bridge: { enabled: boolean } };
  assert.equal(body.channelId, CHANNEL_ID);
  assert.equal(body.action, "close");
  assert.equal(body.bridge.enabled, false);
});

test("POST /v1/channels/:channelId/withdraw returns enabled:false when vault not configured", async () => {
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/channels/${CHANNEL_ID}/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    }),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { channelId: string; action: string; bridge: { enabled: boolean } };
  assert.equal(body.channelId, CHANNEL_ID);
  assert.equal(body.action, "withdraw");
  assert.equal(body.bridge.enabled, false);
});

test("POST /v1/channels/:channelId/close with optional sig fields passes validation", async () => {
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/channels/${CHANNEL_ID}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timestamp: 1234567890, signature: `0x${"b".repeat(130)}` })
    }),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { bridge: { enabled: boolean } };
  assert.equal(body.bridge.enabled, false);
});

test("POST /v1/channels/:channelId/close rejects invalid signature format", async () => {
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/channels/${CHANNEL_ID}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature: "not-a-hex-sig" })
    }),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 400);
});

test("POST /v1/accounts/:account/operator-consent returns 400 on missing body fields", async () => {
  const buyer = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${buyer}/operator-consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    }),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 400);
});

test("POST /v1/accounts/:account/operator-consent returns enabled:false when vault not configured", async () => {
  const buyer = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${buyer}/operator-consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce: "0",
        signature: `0x${"a".repeat(130)}`
      })
    }),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { buyer: string; bridge: { enabled: boolean } };
  assert.equal(body.buyer, buyer);
  assert.equal(body.bridge.enabled, false);
});

test("POST /v1/accounts/:account/withdraw returns 400 on missing body fields", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${account}/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    }),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 400);
});

test("POST /v1/accounts/:account/withdraw returns 400 on invalid recipient address", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${account}/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amount: "5000000",
        recipient: "not-an-address",
        timestamp: 1234567890,
        signature: `0x${"b".repeat(130)}`
      })
    }),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 400);
});

test("POST /v1/accounts/:account/withdraw returns enabled:false when vault not configured", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const recipient = "0x0000000000000000000000000000000000000def";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${account}/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amount: "5000000",
        recipient,
        timestamp: 1234567890,
        signature: `0x${"b".repeat(130)}`
      })
    }),
    env(),
    {} as ExecutionContext
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { account: string; amountUsd: string; bridge: { enabled: boolean } };
  assert.equal(body.account, account);
  assert.equal(body.amountUsd, "5000000");
  assert.equal(body.bridge.enabled, false);
});

test("/v1/celo/events/record processes StreamUpdated logs into stream credits", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000aaa";
  const txHash = `0x${"3".repeat(64)}`;
  const celoVault = "0x0000000000000000000000000000000000000def";
  const goodIdAddr = "0x0000000000000000000000000000000000001234";
  const originalFetch = globalThis.fetch;

  try {
    const testEnv = env({
      CELO_RPC_URL: "https://celo.rpc.local",
      CELO_VAULT_ADDRESS: celoVault,
      CELO_GOODID_ADDRESS: goodIdAddr
    });

    // totalFlowWei = 2 G$, flowRate ≈ 1 G$/month, monthlyGdAmountWei = 1 G$
    const streamLog = encodeVaultEventLog(
      "StreamUpdated",
      [account, buyer, 385_802_469_136n, 1_000_000_000_000_000_000n, 2_000_000_000_000_000_000n],
      celoVault,
      txHash,
      0
    );

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_call") {
        // GoodID root lookup — non-zero root means verified (32-byte ABI-encoded address)
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: "0x000000000000000000000000abababababababababababababababababababab"
        });
      }
      // eth_getTransactionReceipt
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { logs: [streamLog] } });
    }) as typeof fetch;

    const res = await worker.fetch(
      new Request("https://worker.test/v1/celo/events/record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash })
      }),
      testEnv,
      {} as ExecutionContext
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      events: Array<{ source: string; fundingStatus: string; principalUsd: string; bonusUsd: string; buyerAddress?: string }>;
    };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].source, "streamUpdate");
    assert.equal(body.events[0].fundingStatus, "funded");
    // GD_CUSD_PRICE default = 0.0001; totalFlowWei = 2 G$ → principalUsd = 200
    assert.equal(body.events[0].principalUsd, "200");
    // verified + stream source → 20% bonus: 200 × 20% = 40
    assert.equal(body.events[0].bonusUsd, "40");
    assert.equal(body.events[0].buyerAddress, buyer.toLowerCase());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/v1/celo/events/record processes account+fromBlock range query", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000aaa";
  const txHash = `0x${"4".repeat(64)}`;
  const celoVault = "0x0000000000000000000000000000000000000def";
  const originalFetch = globalThis.fetch;

  try {
    const testEnv = env({ CELO_RPC_URL: "https://celo.rpc.local", CELO_VAULT_ADDRESS: celoVault });

    const depositLog = encodeVaultEventLog("GdDeposited", [account, buyer, 1_000_000_000_000_000_000n, "0x"], celoVault, txHash, 0);

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_call") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x0000000000000000000000000000000000000000000000000000000000000000" });
      }
      if (body.method === "eth_getLogs") {
        // eth_getLogs returns logs array directly (not wrapped in { logs: [] })
        return Response.json({ jsonrpc: "2.0", id: body.id, result: [depositLog] });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: null });
    }) as typeof fetch;

    const res = await worker.fetch(
      new Request("https://worker.test/v1/celo/events/record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account, fromBlock: "0x1000000", toBlock: "latest" })
      }),
      testEnv,
      {} as ExecutionContext
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      account: string;
      fromBlock: string;
      toBlock: string;
      events: Array<{ source: string }>;
    };
    assert.equal(body.account, account.toLowerCase());
    assert.equal(body.fromBlock, "0x1000000");
    assert.equal(body.toBlock, "latest");
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].source, "deposit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /v1/accounts/:account/outstanding returns failed funding entries", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const kv = new MemoryKV();

  const failedEntry = {
    id: "deposit:fail:test",
    account: account.toLowerCase(),
    rootAccount: account.toLowerCase(),
    source: "deposit",
    gdAmountWei: "1000000000000000000",
    principalUsd: "100",
    bonusUsd: "0",
    totalCreditUsd: "100",
    streamUpdateMonth: "2026-06",
    fundingStatus: "failed",
    fundingError: "vault reverted",
    createdAt: new Date().toISOString()
  };
  await kv.put("gd-credit:deposit:fail:test", JSON.stringify(failedEntry));
  await kv.put(`user-gd-credits:${account.toLowerCase()}`, JSON.stringify(["deposit:fail:test"]));
  await kv.put(
    `user:${account.toLowerCase()}`,
    JSON.stringify({
      account: account.toLowerCase(),
      totalOutstandingFundingUsd: "100"
    })
  );

  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${account}/outstanding`),
    env({ ANTSEED_KV: kv as never }),
    {} as ExecutionContext
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    account: string;
    outstandingFundingUsd: string;
    failedFundingCredits: Array<{ fundingStatus: string; fundingError: string }>;
  };
  assert.equal(body.account, account.toLowerCase());
  assert.equal(body.outstandingFundingUsd, "100");
  assert.equal(body.failedFundingCredits.length, 1);
  assert.equal(body.failedFundingCredits[0].fundingStatus, "failed");
  assert.equal(body.failedFundingCredits[0].fundingError, "vault reverted");
});

test("POST /v1/accounts/:account/stream-credits rate-limits when credits issued within 24h", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const celoVault = "0x0000000000000000000000000000000000000def";
  const gdSuperToken = "0x0000000000000000000000000000000000000fed";
  const kv = new MemoryKV();
  // Pre-seed user with a very recent lastStreamCreditAt (just now)
  await kv.put(
    `user:${account.toLowerCase()}`,
    JSON.stringify({
      account: account.toLowerCase(),
      lastStreamCreditAt: new Date().toISOString()
    })
  );

  const originalFetch = globalThis.fetch;
  try {
    const testEnv = env({
      CELO_VAULT_ADDRESS: celoVault,
      CELO_GD_SUPERTOKEN_ADDRESS: gdSuperToken,
      ANTSEED_KV: kv as never
    });

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.query) {
        return Response.json({
          data: {
            streams: [
              {
                sender: { id: account },
                currentFlowRate: "1000000000000000",
                updatedAtTimestamp: "1735000000",
                flowUpdatedEvents: [{ userData: "0x" }]
              }
            ]
          }
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x0000000000000000000000000000000000000000000000000000000000000000" });
    }) as typeof fetch;

    const res = await worker.fetch(
      new Request(`https://worker.test/v1/accounts/${account}/stream-credits`, {
        method: "POST",
        headers: { "content-type": "application/json" }
      }),
      testEnv,
      {} as ExecutionContext
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as { account: string; streams: unknown[]; message: string };
    assert.equal(body.streams.length, 0);
    assert.ok(body.message.includes("stream credits were issued less than"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /v1/accounts/:account/stream-credits skips streams below minimum G$ amount", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const celoVault = "0x0000000000000000000000000000000000000def";
  const gdSuperToken = "0x0000000000000000000000000000000000000fed";
  const originalFetch = globalThis.fetch;

  try {
    const testEnv = env({
      CELO_VAULT_ADDRESS: celoVault,
      CELO_GD_SUPERTOKEN_ADDRESS: gdSuperToken
    });

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.query) {
        // 1 wei/sec flow rate — elapsed × 1 wei << 800 G$ minimum
        return Response.json({
          data: {
            streams: [
              {
                sender: { id: account },
                currentFlowRate: "1",
                updatedAtTimestamp: "1735000000",
                flowUpdatedEvents: [{ userData: "0x" }]
              }
            ]
          }
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x0000000000000000000000000000000000000000000000000000000000000000" });
    }) as typeof fetch;

    const res = await worker.fetch(
      new Request(`https://worker.test/v1/accounts/${account}/stream-credits`, {
        method: "POST",
        headers: { "content-type": "application/json" }
      }),
      testEnv,
      {} as ExecutionContext
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as { account: string; elapsedSeconds: number; streams: Array<{ message: string }> };
    assert.ok(body.elapsedSeconds > 0);
    assert.equal(body.streams.length, 1);
    assert.ok(body.streams[0].message.includes("below minimum"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
