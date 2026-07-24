import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
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

const ChannelsEvents = new Interface([
  "event Reserved(bytes32 indexed channelId,address indexed buyer,address indexed seller,uint128 maxAmount)",
  "event ChannelSettled(bytes32 indexed channelId,address indexed buyer,address indexed seller,uint128 cumulativeAmount,uint128 delta,uint128 totalSettled,uint256 platformFee,bytes metadata)"
]);

function encodeChannelLog(
  eventName: "Reserved" | "ChannelSettled",
  args: readonly unknown[],
  address: string,
  txHash: string,
  logIndex: number,
  blockNumber: number,
  timestamp: number
) {
  const event = ChannelsEvents.getEvent(eventName);
  if (!event) throw new Error(`unknown event ${eventName}`);
  const encoded = ChannelsEvents.encodeEventLog(event, args);
  return {
    address,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: txHash,
    logIndex: `0x${logIndex.toString(16)}`,
    blockNumber: `0x${blockNumber.toString(16)}`,
    timeStamp: `0x${timestamp.toString(16)}`
  };
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
  const res = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/credit-history?source=not-a-source`), env(), {} as ExecutionContext);
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

test("analytics refresh overwrites current day and query adds current day to persisted globals", { concurrency: false }, async () => {
  const testEnv = env({
    CELO_VAULT_ADDRESS: "0x4Dd0136b9aabD5823cf0F65d89e8fB882C660885",
    CELO_GD_SUPERTOKEN_ADDRESS: "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A",
    CELO_BLOCKSCOUT_API_URL: "https://celo.blockscout.test/api",
    BASE_BLOCKSCOUT_API_URL: "https://base.blockscout.test/api",
    ANTSEED_CHANNELS_ADDRESS: "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d",
    SUPERFLUID_SUBGRAPH_URL: "https://superfluid.test/subgraph"
  });

  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000def";
  const seller = "0x0000000000000000000000000000000000000fed";
  const channelId = `0x${"1".repeat(64)}`;
  const now = new Date("2026-07-24T12:00:00.000Z");
  const timestamp = Math.floor(now.getTime() / 1000) - 60;
  const date = now.toISOString().slice(0, 10);

  const celoDepositLog = {
    ...encodeVaultEventLog("GdDeposited", [account, buyer, 2_000_000_000_000_000_000n, "0x"], testEnv.CELO_VAULT_ADDRESS!, `0x${"2".repeat(64)}`, 0),
    blockNumber: "0x64",
    timeStamp: `0x${timestamp.toString(16)}`
  };

  const reservedLog = encodeChannelLog(
    "Reserved",
    [channelId, buyer, seller, 1_000_000n],
    testEnv.ANTSEED_CHANNELS_ADDRESS!,
    `0x${"3".repeat(64)}`,
    0,
    210,
    timestamp
  );
  const settledLog = encodeChannelLog(
    "ChannelSettled",
    [channelId, buyer, seller, 3_000_000n, 500_000n, 1_000_000n, 0n, "0x"],
    testEnv.ANTSEED_CHANNELS_ADDRESS!,
    `0x${"4".repeat(64)}`,
    1,
    211,
    timestamp
  );

  const originalFetch = globalThis.fetch;
  try {
    let celoAmountWei = 2_000_000_000_000_000_000n;

    globalThis.fetch = (async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = typeof urlInput === "string" ? new URL(urlInput) : urlInput instanceof URL ? urlInput : new URL(urlInput.url);

      if (url.host === "celo.blockscout.test") {
        const module = url.searchParams.get("module");
        const action = url.searchParams.get("action");
        if (module === "block" && action === "getblocknobytime") {
          return Response.json({ status: "1", message: "OK", result: "100" });
        }
        if (module === "proxy" && action === "eth_blockNumber") {
          return Response.json({ result: "0x64" });
        }
        if (module === "logs" && action === "getLogs") {
          const dynamicCeloLog = {
            ...encodeVaultEventLog("GdDeposited", [account, buyer, celoAmountWei, "0x"], testEnv.CELO_VAULT_ADDRESS!, `0x${"2".repeat(64)}`, 0),
            blockNumber: "0x64",
            timeStamp: `0x${timestamp.toString(16)}`
          };
          return Response.json({ status: "1", message: "OK", result: [dynamicCeloLog] });
        }
      }

      if (url.host === "base.blockscout.test") {
        const module = url.searchParams.get("module");
        const action = url.searchParams.get("action");
        if (module === "block" && action === "getblocknobytime") {
          return Response.json({ status: "1", message: "OK", result: "200" });
        }
        if (module === "proxy" && action === "eth_blockNumber") {
          return Response.json({ result: "0xd3" });
        }
        if (module === "logs" && action === "getLogs") {
          const topic0 = url.searchParams.get("topic0")?.toLowerCase();
          const reservedTopic = ChannelsEvents.getEvent("Reserved")?.topicHash.toLowerCase();
          const settledTopic = ChannelsEvents.getEvent("ChannelSettled")?.topicHash.toLowerCase();
          if (topic0 === reservedTopic) {
            return Response.json({ status: "1", message: "OK", result: [reservedLog] });
          }
          if (topic0 === settledTopic) {
            return Response.json({ status: "1", message: "OK", result: [settledLog] });
          }
          return Response.json({ status: "0", message: "No records found", result: "No records found" });
        }
      }

      if (url.host === "superfluid.test") {
        const body = JSON.parse(String(init?.body)) as { variables: { skip: number } };
        if (body.variables.skip > 0) {
          return Response.json({ data: { streams: [] } });
        }
        return Response.json({
          data: {
            streams: [
              {
                sender: { id: account },
                currentFlowRate: "0",
                streamedUntilUpdatedAt: "1000000000000000000",
                updatedAtTimestamp: String(timestamp)
              }
            ]
          }
        });
      }

      throw new Error(`unexpected fetch url: ${url.toString()}`);
    }) as typeof fetch;

    await import("../src/analytics.js").then(async ({ runAnalyticsAggregation }) => {
      await runAnalyticsAggregation(testEnv, now);
    });

    celoAmountWei = 5_000_000_000_000_000_000n;

    await import("../src/analytics.js").then(async ({ runAnalyticsAggregation }) => {
      await runAnalyticsAggregation(testEnv, now);
    });

    const analyticsBody = (await import("../src/analytics.js").then(async ({ getAnalyticsWindow }) => getAnalyticsWindow(testEnv, 1, now))) as {
      daily: Array<{
        date: string;
        gdOneTimeDepositsWei: string;
        gdStreamedWei: string;
        aiCreditsUsedWei: string;
        uniqueGdBuyers: number;
        uniqueCreditUsers: number;
      }>;
      global: {
        gdOneTimeDepositsWei: string;
        gdStreamedWei: string;
        aiCreditsUsedWei: string;
      };
    };

    assert.equal(analyticsBody.daily.length, 1);
    assert.equal(analyticsBody.daily[0].date, date);
    assert.equal(analyticsBody.daily[0].gdOneTimeDepositsWei, "5000000000000000000");
    assert.equal(analyticsBody.daily[0].gdStreamedWei, "1000000000000000000");
    assert.equal(analyticsBody.daily[0].aiCreditsUsedWei, "500000");
    assert.equal(analyticsBody.daily[0].uniqueGdBuyers, 1);
    assert.equal(analyticsBody.daily[0].uniqueCreditUsers, 1);
    assert.equal(analyticsBody.global.gdOneTimeDepositsWei, "5000000000000000000");
    assert.equal(analyticsBody.global.gdStreamedWei, "1000000000000000000");
    assert.equal(analyticsBody.global.aiCreditsUsedWei, "500000");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analytics refresh excludes base usage for buyers outside known buyer registry", { concurrency: false }, async () => {
  const testEnv = env({
    CELO_VAULT_ADDRESS: "0x4Dd0136b9aabD5823cf0F65d89e8fB882C660885",
    CELO_GD_SUPERTOKEN_ADDRESS: "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A",
    CELO_BLOCKSCOUT_API_URL: "https://celo.blockscout.test/api",
    BASE_BLOCKSCOUT_API_URL: "https://base.blockscout.test/api",
    ANTSEED_CHANNELS_ADDRESS: "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d",
    SUPERFLUID_SUBGRAPH_URL: "https://superfluid.test/subgraph"
  });

  const account = "0x0000000000000000000000000000000000000abc";
  const knownBuyer = "0x0000000000000000000000000000000000000def";
  const unknownBuyer = "0x0000000000000000000000000000000000000bad";
  const seller = "0x0000000000000000000000000000000000000fed";
  const channelId = `0x${"7".repeat(64)}`;
  const now = new Date("2026-07-24T12:00:00.000Z");
  const timestamp = Math.floor(now.getTime() / 1000) - 60;

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = typeof urlInput === "string" ? new URL(urlInput) : urlInput instanceof URL ? urlInput : new URL(urlInput.url);

      if (url.host === "celo.blockscout.test") {
        if (url.searchParams.get("module") === "block" && url.searchParams.get("action") === "getblocknobytime") {
          return Response.json({ status: "1", message: "OK", result: "100" });
        }
        if (url.searchParams.get("module") === "logs") {
          return Response.json({
            status: "1",
            message: "OK",
            result: [
              {
                ...encodeVaultEventLog(
                  "GdDeposited",
                  [account, knownBuyer, 1_000_000_000_000_000_000n, "0x"],
                  testEnv.CELO_VAULT_ADDRESS!,
                  `0x${"8".repeat(64)}`,
                  0
                ),
                blockNumber: "0x64",
                timeStamp: `0x${timestamp.toString(16)}`
              }
            ]
          });
        }
      }

      if (url.host === "base.blockscout.test") {
        if (url.searchParams.get("module") === "block" && url.searchParams.get("action") === "getblocknobytime") {
          return Response.json({ status: "1", message: "OK", result: "200" });
        }
        if (url.searchParams.get("module") === "logs") {
          const topic0 = url.searchParams.get("topic0")?.toLowerCase();
          const settledTopic = ChannelsEvents.getEvent("ChannelSettled")?.topicHash.toLowerCase();
          if (topic0 === settledTopic) {
            const known = encodeChannelLog(
              "ChannelSettled",
              [channelId, knownBuyer, seller, 3_000_000n, 500_000n, 1_000_000n, 0n, "0x"],
              testEnv.ANTSEED_CHANNELS_ADDRESS!,
              `0x${"9".repeat(64)}`,
              1,
              211,
              timestamp
            );
            const unknown = encodeChannelLog(
              "ChannelSettled",
              [channelId, unknownBuyer, seller, 5_000_000n, 700_000n, 2_000_000n, 0n, "0x"],
              testEnv.ANTSEED_CHANNELS_ADDRESS!,
              `0x${"6".repeat(64)}`,
              2,
              212,
              timestamp
            );
            return Response.json({ status: "1", message: "OK", result: [known, unknown] });
          }
          return Response.json({ status: "0", message: "No records found", result: "No records found" });
        }
      }

      if (url.host === "superfluid.test") {
        const body = JSON.parse(String(init?.body)) as { variables: { skip: number } };
        if (body.variables.skip > 0) {
          return Response.json({ data: { streams: [] } });
        }
        return Response.json({
          data: {
            streams: [
              {
                sender: { id: account },
                currentFlowRate: "0",
                streamedUntilUpdatedAt: "0",
                updatedAtTimestamp: String(timestamp)
              }
            ]
          }
        });
      }

      throw new Error(`unexpected fetch url: ${url.toString()}`);
    }) as typeof fetch;

    await import("../src/analytics.js").then(async ({ runAnalyticsAggregation }) => {
      await runAnalyticsAggregation(testEnv, now);
    });

    const analyticsBody = (await import("../src/analytics.js").then(async ({ getAnalyticsWindow }) => getAnalyticsWindow(testEnv, 1, now))) as {
      daily: Array<{
        aiCreditsUsedWei: string;
        uniqueCreditUsers: number;
      }>;
    };

    assert.equal(analyticsBody.daily[0].aiCreditsUsedWei, "500000");
    assert.equal(analyticsBody.daily[0].uniqueCreditUsers, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analytics refresh finalizes previous day into persisted globals once day rolls over", { concurrency: false }, async () => {
  const testEnv = env({
    CELO_VAULT_ADDRESS: "0x4Dd0136b9aabD5823cf0F65d89e8fB882C660885",
    CELO_GD_SUPERTOKEN_ADDRESS: "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A",
    CELO_BLOCKSCOUT_API_URL: "https://celo.blockscout.test/api",
    BASE_BLOCKSCOUT_API_URL: "https://base.blockscout.test/api",
    ANTSEED_CHANNELS_ADDRESS: "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d",
    SUPERFLUID_SUBGRAPH_URL: "https://superfluid.test/subgraph"
  });

  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000def";
  const seller = "0x0000000000000000000000000000000000000fed";
  const channelId = `0x${"9".repeat(64)}`;
  const firstNow = new Date("2026-07-23T10:00:00.000Z");
  const secondNow = new Date("2026-07-24T01:00:00.000Z");

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = typeof urlInput === "string" ? new URL(urlInput) : urlInput instanceof URL ? urlInput : new URL(urlInput.url);

      const activeNow = url.host === "superfluid.test" ? (JSON.parse(String(init?.body)) as { variables: { skip: number } }).variables.skip : 0;
      const timestamp = Math.floor(firstNow.getTime() / 1000) - 60;

      if (url.host === "celo.blockscout.test") {
        if (url.searchParams.get("module") === "block" && url.searchParams.get("action") === "getblocknobytime") {
          return Response.json({ status: "1", message: "OK", result: "100" });
        }
        if (url.searchParams.get("module") === "logs") {
          return Response.json({
            status: "1",
            message: "OK",
            result: [
              {
                ...encodeVaultEventLog(
                  "GdDeposited",
                  [account, buyer, 2_000_000_000_000_000_000n, "0x"],
                  testEnv.CELO_VAULT_ADDRESS!,
                  `0x${"a".repeat(64)}`,
                  0
                ),
                blockNumber: "0x64",
                timeStamp: `0x${timestamp.toString(16)}`
              }
            ]
          });
        }
      }

      if (url.host === "base.blockscout.test") {
        if (url.searchParams.get("module") === "block" && url.searchParams.get("action") === "getblocknobytime") {
          return Response.json({ status: "1", message: "OK", result: "200" });
        }
        if (url.searchParams.get("module") === "logs") {
          const topic0 = url.searchParams.get("topic0")?.toLowerCase();
          const settledTopic = ChannelsEvents.getEvent("ChannelSettled")?.topicHash.toLowerCase();
          if (topic0 === settledTopic) {
            return Response.json({
              status: "1",
              message: "OK",
              result: [
                encodeChannelLog(
                  "ChannelSettled",
                  [channelId, buyer, seller, 3_000_000n, 500_000n, 1_000_000n, 0n, "0x"],
                  testEnv.ANTSEED_CHANNELS_ADDRESS!,
                  `0x${"b".repeat(64)}`,
                  1,
                  211,
                  timestamp
                )
              ]
            });
          }
          return Response.json({ status: "0", message: "No records found", result: "No records found" });
        }
      }

      if (url.host === "superfluid.test") {
        if (activeNow > 0) {
          return Response.json({ data: { streams: [] } });
        }
        return Response.json({
          data: {
            streams: [
              {
                sender: { id: account },
                currentFlowRate: "0",
                streamedUntilUpdatedAt: "1000000000000000000",
                updatedAtTimestamp: String(timestamp)
              }
            ]
          }
        });
      }

      throw new Error(`unexpected fetch url: ${url.toString()}`);
    }) as typeof fetch;

    await import("../src/analytics.js").then(async ({ runAnalyticsAggregation }) => {
      await runAnalyticsAggregation(testEnv, firstNow);
      await runAnalyticsAggregation(testEnv, secondNow);
    });

    const analyticsBody = await import("../src/analytics.js").then(async ({ getAnalyticsWindow }) => getAnalyticsWindow(testEnv, 2, secondNow));
    assert.equal(analyticsBody.global.gdOneTimeDepositsWei, "4000000000000000000");
    assert.equal(analyticsBody.global.gdStreamedWei, "1000000000000000000");
    assert.equal(analyticsBody.global.aiCreditsUsedWei, "1000000");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analytics refresh collects logs beyond the explorer 1000-result cap", { concurrency: false }, async () => {
  const testEnv = env({
    CELO_VAULT_ADDRESS: "0x4Dd0136b9aabD5823cf0F65d89e8fB882C660885",
    CELO_GD_SUPERTOKEN_ADDRESS: "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A",
    CELO_BLOCKSCOUT_API_URL: "https://celo.blockscout.test/api",
    BASE_BLOCKSCOUT_API_URL: "https://base.blockscout.test/api",
    ANTSEED_CHANNELS_ADDRESS: "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d",
    SUPERFLUID_SUBGRAPH_URL: "https://superfluid.test/subgraph"
  });

  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000def";
  const now = new Date("2026-07-24T12:00:00.000Z");
  const timestamp = Math.floor(now.getTime() / 1000) - 60;
  const totalLogs = 1001;
  const expectedDepositsWei = (1_000_000_000_000_000_000n * BigInt(totalLogs)).toString();
  const celoLogs = Array.from({ length: totalLogs }, (_, index) => ({
    ...encodeVaultEventLog(
      "GdDeposited",
      [account, buyer, 1_000_000_000_000_000_000n, "0x"],
      testEnv.CELO_VAULT_ADDRESS!,
      `0x${(index + 1).toString(16).padStart(64, "0")}`,
      0
    ),
    blockNumber: `0x${(100 + index).toString(16)}`,
    timeStamp: `0x${timestamp.toString(16)}`
  }));

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = typeof urlInput === "string" ? new URL(urlInput) : urlInput instanceof URL ? urlInput : new URL(urlInput.url);

      if (url.host === "celo.blockscout.test") {
        const module = url.searchParams.get("module");
        const action = url.searchParams.get("action");
        if (module === "block" && action === "getblocknobytime") {
          const closest = url.searchParams.get("closest");
          return Response.json({ status: "1", message: "OK", result: closest === "after" ? "100" : String(99 + totalLogs) });
        }
        if (module === "logs" && action === "getLogs") {
          const fromBlock = Number(url.searchParams.get("fromBlock"));
          const toBlock = Number(url.searchParams.get("toBlock"));
          const filtered = celoLogs.filter((log) => {
            const blockNumber = Number.parseInt(log.blockNumber, 16);
            return blockNumber >= fromBlock && blockNumber <= toBlock;
          });
          return Response.json({ status: "1", message: "OK", result: filtered.slice(0, 1000) });
        }
      }

      if (url.host === "base.blockscout.test") {
        const module = url.searchParams.get("module");
        const action = url.searchParams.get("action");
        if (module === "block" && action === "getblocknobytime") {
          return Response.json({ status: "1", message: "OK", result: "200" });
        }
        if (module === "logs" && action === "getLogs") {
          return Response.json({ status: "0", message: "No records found", result: "No records found" });
        }
      }

      if (url.host === "superfluid.test") {
        const body = JSON.parse(String(init?.body)) as { variables: { skip: number } };
        if (body.variables.skip > 0) {
          return Response.json({ data: { streams: [] } });
        }
        return Response.json({ data: { streams: [] } });
      }

      throw new Error(`unexpected fetch url: ${url.toString()}`);
    }) as typeof fetch;

    await import("../src/analytics.js").then(async ({ runAnalyticsAggregation }) => {
      await runAnalyticsAggregation(testEnv, now);
    });

    const analyticsBody = (await import("../src/analytics.js").then(async ({ getAnalyticsWindow }) => getAnalyticsWindow(testEnv, 1, now))) as {
      daily: Array<{
        gdOneTimeDepositsWei: string;
        uniqueGdBuyers: number;
      }>;
      global: {
        gdOneTimeDepositsWei: string;
      };
    };

    assert.equal(analyticsBody.daily[0].gdOneTimeDepositsWei, expectedDepositsWei);
    assert.equal(analyticsBody.daily[0].uniqueGdBuyers, 1);
    assert.equal(analyticsBody.global.gdOneTimeDepositsWei, expectedDepositsWei);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
