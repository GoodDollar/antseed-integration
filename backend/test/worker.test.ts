import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import worker, { fundCredit } from "../src/worker.js";
import { Env } from "../src/env.js";
import { KVCreditStore } from "../src/kv-credit-store.js";
import { encodeVaultEventLog } from "../src/celo-events.js";
import { GdCreditEntry } from "../src/types.js";

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

function makeExecutionContext(): ExecutionContext {
  return {
    waitUntil(_promise: Promise<unknown>) {},
    passThroughOnException() {}
  } as unknown as ExecutionContext;
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

function toHexQuantity(value: number | bigint): string {
  const num = typeof value === "number" ? BigInt(value) : value;
  return `0x${num.toString(16)}`;
}

function makeRpcBlock(blockNumber: bigint, timestamp: bigint) {
  return {
    number: toHexQuantity(blockNumber),
    hash: `0x${"1".repeat(64)}`,
    parentHash: `0x${"2".repeat(64)}`,
    nonce: "0x0000000000000000",
    sha3Uncles: `0x${"3".repeat(64)}`,
    logsBloom: `0x${"0".repeat(512)}`,
    transactionsRoot: `0x${"4".repeat(64)}`,
    stateRoot: `0x${"5".repeat(64)}`,
    receiptsRoot: `0x${"6".repeat(64)}`,
    miner: "0x0000000000000000000000000000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    timestamp: toHexQuantity(timestamp),
    transactions: [],
    uncles: [],
    baseFeePerGas: "0x1",
    mixHash: `0x${"7".repeat(64)}`,
    withdrawals: []
  };
}

function blockNumberFromLog(log: { blockNumber?: string | number }): bigint {
  if (typeof log.blockNumber === "number") return BigInt(log.blockNumber);
  if (typeof log.blockNumber === "string") return log.blockNumber.startsWith("0x") ? BigInt(log.blockNumber) : BigInt(Number.parseInt(log.blockNumber, 10));
  return 0n;
}

function buildOfflineAnalyticsFetchMock(options: {
  dayStartUnix: number;
  dayEndUnix: number;
  baseBlockSeconds?: number;
  explorerFromBlock?: number;
  explorerToBlock?: number;
  celoVaultAddress?: string;
  baseChannelsAddress: string;
  skipBaseRangeFilter?: boolean;
  getCeloLogs?: () => Array<{ topics: string[]; blockNumber?: string | number }>;
  getBaseLogsByTopic?: () => Record<string, Array<{ topics: string[]; blockNumber?: string | number }>>;
  getStreamPeriods?: () => Array<{
    sender: { id: string };
    flowRate: string;
    startedAtTimestamp: string;
    stoppedAtTimestamp: string | null;
    stream: { userData: string };
  }>;
}) {
  const latestBaseBlock = 50_000_000n;
  const latestBaseTimestamp = BigInt(options.dayEndUnix + 7200);
  const baseBlockSeconds = BigInt(options.baseBlockSeconds ?? 2);

  return (async (urlInput: string | URL | Request, init?: RequestInit) => {
    const url = typeof urlInput === "string" ? new URL(urlInput) : urlInput instanceof URL ? urlInput : new URL(urlInput.url);

    if (url.host === "chainlist.org") {
      return Response.json([
        { chainId: 42220, rpc: ["https://celo.rpc.test"] },
        { chainId: 8453, rpc: ["https://base.rpc.test"] }
      ]);
    }

    if (url.host === "celo.blockscout.test" || url.host === "base.blockscout.test") {
      if (url.searchParams.get("action") === "getblocknobytime") {
        const closest = url.searchParams.get("closest");
        const fromBlock = options.explorerFromBlock ?? 100;
        const toBlock = options.explorerToBlock ?? 120;
        const block = closest === "after" ? String(fromBlock) : String(toBlock);
        return Response.json({ status: "1", message: "OK", result: block });
      }
    }

    if (url.host === "superfluid.test") {
      const body = JSON.parse(String(init?.body)) as { variables: { skip: number } };
      if (body.variables.skip > 0) {
        return Response.json({ data: { streamPeriods: [] } });
      }
      return Response.json({ data: { streamPeriods: options.getStreamPeriods ? options.getStreamPeriods() : [] } });
    }

    if (url.host === "celo.rpc.test" || url.host === "base.rpc.test") {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: Array<any>;
      };

      if (body.method === "eth_getLogs") {
        const filter = body.params[0] as { address: string; topics?: string[]; fromBlock: string; toBlock: string };
        const fromBlock = BigInt(filter.fromBlock);
        const toBlock = BigInt(filter.toBlock);
        const address = filter.address.toLowerCase();

        let logs: Array<{ topics: string[]; blockNumber?: string | number }> = [];
        if (options.celoVaultAddress && address === options.celoVaultAddress.toLowerCase()) {
          logs = options.getCeloLogs ? options.getCeloLogs() : [];
        } else if (address === options.baseChannelsAddress.toLowerCase()) {
          const topic0 = (filter.topics?.[0] ?? "").toLowerCase();
          const topicMap = options.getBaseLogsByTopic ? options.getBaseLogsByTopic() : {};
          logs = topicMap[topic0] ?? [];
        }

        const shouldSkipFilter = options.skipBaseRangeFilter && address === options.baseChannelsAddress.toLowerCase();
        const filtered = shouldSkipFilter
          ? logs
          : logs.filter((log) => {
              const blockNumber = blockNumberFromLog(log);
              return blockNumber >= fromBlock && blockNumber <= toBlock;
            });

        return Response.json({ jsonrpc: "2.0", id: body.id, result: filtered });
      }

      if (body.method === "eth_getBlockByNumber") {
        const blockTag = body.params[0] as string;
        const blockNumber = blockTag === "latest" ? latestBaseBlock : BigInt(blockTag);
        const delta = latestBaseBlock - blockNumber;
        const timestamp = latestBaseTimestamp - delta * baseBlockSeconds;
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: makeRpcBlock(blockNumber, timestamp)
        });
      }
    }

    throw new Error(`unexpected fetch url: ${url.toString()}`);
  }) as typeof fetch;
}

test("health exposes bridge status", async () => {
  const res = await worker.fetch(new Request("https://worker.test/health"), env(), makeExecutionContext());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { bridgeEnabled: boolean };
  assert.equal(body.bridgeEnabled, false);
});

test("config status documents celo-to-base bridge mode", async () => {
  const res = await worker.fetch(new Request("https://worker.test/config/status"), env(), makeExecutionContext());
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    bridge: { celoVaultEvents: boolean; baseBuyerOperatorEnabled: boolean; mode: string };
  };
  assert.equal(body.bridge.celoVaultEvents, true);
  assert.equal(body.bridge.baseBuyerOperatorEnabled, false);
  assert.equal(body.bridge.mode, "celo-vault-to-base-buyer-operator");
});

test("config values exposes non-secret runtime constants", async () => {
  const res = await worker.fetch(new Request("https://worker.test/config/values"), env(), makeExecutionContext());
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

test("GET /v1/analytics returns analytics window with CORS headers", async () => {
  const res = await worker.fetch(new Request("https://worker.test/v1/analytics?days=2"), env(), makeExecutionContext());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const body = (await res.json()) as { days: number; daily: Array<{ date: string }>; lastRun: { currentDate: string } };
  assert.equal(body.days, 2);
  assert.equal(body.daily.length, 2);
  assert.equal(body.daily[1].date, body.lastRun.currentDate);
});

test("POST /v1/analytics/refresh returns aggregation summary", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;

  try {
    const testEnv = env({
      CELO_VAULT_ADDRESS: "0x4Dd0136b9aabD5823cf0F65d89e8fB882C660885",
      CELO_GD_SUPERTOKEN_ADDRESS: "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A",
      CELO_BLOCKSCOUT_API_URL: "https://celo.blockscout.test/api",
      BASE_BLOCKSCOUT_API_URL: "https://base.blockscout.test/api",
      ANTSEED_CHANNELS_ADDRESS: "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d",
      SUPERFLUID_SUBGRAPH_URL: "https://superfluid.test/subgraph"
    });
    const now = new Date();
    const dayStartUnix = Math.floor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)).getTime() / 1000);
    const dayEndUnix = dayStartUnix + 24 * 60 * 60 - 1;

    globalThis.fetch = buildOfflineAnalyticsFetchMock({
      dayStartUnix,
      dayEndUnix,
      celoVaultAddress: testEnv.CELO_VAULT_ADDRESS,
      baseChannelsAddress: testEnv.ANTSEED_CHANNELS_ADDRESS!,
      getStreamPeriods: () => []
    });

    const res = await worker.fetch(new Request("https://worker.test/v1/analytics/refresh", { method: "POST" }), testEnv, makeExecutionContext());
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{
      currentDate: string;
      finalizedDates: string[];
    }>;
    assert.equal(Array.isArray(body), true);
    assert.equal(body.length > 0, true);
    assert.equal(body.length <= 2, true);
    assert.match(body[0].currentDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(Array.isArray(body[0].finalizedDates), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /v1/analytics/refresh is rate-limited to one call per hour", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;

  try {
    const testEnv = env({
      CELO_VAULT_ADDRESS: "0x4Dd0136b9aabD5823cf0F65d89e8fB882C660885",
      CELO_GD_SUPERTOKEN_ADDRESS: "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A",
      CELO_BLOCKSCOUT_API_URL: "https://celo.blockscout.test/api",
      BASE_BLOCKSCOUT_API_URL: "https://base.blockscout.test/api",
      ANTSEED_CHANNELS_ADDRESS: "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d",
      SUPERFLUID_SUBGRAPH_URL: "https://superfluid.test/subgraph"
    });
    const now = new Date();
    const dayStartUnix = Math.floor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)).getTime() / 1000);
    const dayEndUnix = dayStartUnix + 24 * 60 * 60 - 1;

    globalThis.fetch = buildOfflineAnalyticsFetchMock({
      dayStartUnix,
      dayEndUnix,
      celoVaultAddress: testEnv.CELO_VAULT_ADDRESS,
      baseChannelsAddress: testEnv.ANTSEED_CHANNELS_ADDRESS!,
      getStreamPeriods: () => []
    });

    const first = await worker.fetch(new Request("https://worker.test/v1/analytics/refresh", { method: "POST" }), testEnv, makeExecutionContext());
    assert.equal(first.status, 200);

    const second = await worker.fetch(new Request("https://worker.test/v1/analytics/refresh", { method: "POST" }), testEnv, makeExecutionContext());
    assert.equal(second.status, 429);
    const body = (await second.json()) as { error: string; retryAfterSeconds: number };
    assert.equal(body.error, "analytics refresh is rate-limited");
    assert.equal(body.retryAfterSeconds > 0, true);
    assert.equal(body.retryAfterSeconds <= 3600, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /v1/accounts/:account/profile returns profile only", async () => {
  const testEnv = env();
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/profile`), testEnv, makeExecutionContext());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { account: string; profile: { totalGdDepositedWei: string }; gdCredits?: unknown };
  assert.equal(body.account, account);
  assert.equal(body.profile.totalGdDepositedWei, "0");
  assert.equal(body.gdCredits, undefined);
});

test("GET /v1/accounts/:account/credit-history returns paginated empty history", async () => {
  const testEnv = env();
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/credit-history`), testEnv, makeExecutionContext());
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
  const res = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/credit-history?source=not-a-source`), env(), makeExecutionContext());
  assert.equal(res.status, 400);
});

test("GET /v1/accounts/:account/outstanding returns outstanding funding info", async () => {
  const testEnv = env();
  const account = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/outstanding`), testEnv, makeExecutionContext());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { account: string; outstandingFundingUsd: string; failedFundingCredits: unknown[] };
  assert.equal(body.account, account);
  assert.equal(body.outstandingFundingUsd, "0");
  assert.equal(body.failedFundingCredits.length, 0);
});

test("/v1/celo/events/record processes deposit logs and records credits", { concurrency: false }, async () => {
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
      makeExecutionContext()
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { events: Array<{ id: string; source: string; fundingStatus: string; principalUsd: string; buyerAddress?: string }> };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].source, "deposit");
    assert.equal(body.events[0].fundingStatus, "funded");
    assert.equal(body.events[0].buyerAddress, buyer.toLowerCase());

    // Verify credit was recorded
    const creditRes = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/profile`), testEnv, makeExecutionContext());
    assert.equal(creditRes.status, 200);
    const creditBody = (await creditRes.json()) as { profile: { totalGdDepositedWei: string }; gdCredits?: unknown };
    assert.equal(creditBody.gdCredits, undefined);
    assert.notEqual(creditBody.profile.totalGdDepositedWei, "0");

    const historyRes = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/credit-history`), testEnv, makeExecutionContext());
    assert.equal(historyRes.status, 200);
    const historyBody = (await historyRes.json()) as { items: Array<{ id: string; source: string }> };
    assert.equal(historyBody.items.length, 1);
    assert.equal(historyBody.items[0].source, "deposit");

    const retryRes = await worker.fetch(
      new Request("https://worker.test/v1/celo/events/record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash })
      }),
      testEnv,
      makeExecutionContext()
    );
    assert.equal(retryRes.status, 200);
    const retryBody = (await retryRes.json()) as {
      events: Array<{ id: string; fundingStatus: string; bridge?: { alreadyFunded?: boolean } }>;
    };
    assert.equal(retryBody.events.length, 1);
    assert.equal(retryBody.events[0].id, body.events[0].id);
    assert.equal(retryBody.events[0].fundingStatus, "funded");
    assert.equal(retryBody.events[0].bridge?.alreadyFunded, true);
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
    makeExecutionContext()
  );
  assert.equal(res.status, 400);
});

test("request exceptions send slack webhook with path, body, and error", { concurrency: false }, async () => {
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

test("POST /v1/accounts/:account/stream-credits returns no streams when none active", { concurrency: false }, async () => {
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
      makeExecutionContext()
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
  const res = await worker.fetch(new Request("https://worker.test/nonexistent"), env(), makeExecutionContext());
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "not found");
});

test("OPTIONS returns CORS preflight", async () => {
  const res = await worker.fetch(new Request("https://worker.test/anything", { method: "OPTIONS" }), env(), makeExecutionContext());
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
  const dayStartUnix = Math.floor(new Date("2026-07-24T00:00:00.000Z").getTime() / 1000);
  const dayEndUnix = dayStartUnix + 24 * 60 * 60 - 1;
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
    49_970_000,
    timestamp
  );
  const settledLog = encodeChannelLog(
    "ChannelSettled",
    [channelId, buyer, seller, 3_000_000n, 500_000n, 1_000_000n, 0n, "0x"],
    testEnv.ANTSEED_CHANNELS_ADDRESS!,
    `0x${"4".repeat(64)}`,
    1,
    49_970_001,
    timestamp
  );

  const originalFetch = globalThis.fetch;
  try {
    let celoAmountWei = 2_000_000_000_000_000_000n;

    const reservedTopic = ChannelsEvents.getEvent("Reserved")?.topicHash.toLowerCase() ?? "";
    const settledTopic = ChannelsEvents.getEvent("ChannelSettled")?.topicHash.toLowerCase() ?? "";

    globalThis.fetch = buildOfflineAnalyticsFetchMock({
      dayStartUnix,
      dayEndUnix,
      celoVaultAddress: testEnv.CELO_VAULT_ADDRESS,
      baseChannelsAddress: testEnv.ANTSEED_CHANNELS_ADDRESS!,
      getCeloLogs: () => [
        {
          ...celoDepositLog,
          ...encodeVaultEventLog("GdDeposited", [account, buyer, celoAmountWei, "0x"], testEnv.CELO_VAULT_ADDRESS!, `0x${"2".repeat(64)}`, 0),
          blockNumber: "0x64"
        }
      ],
      getBaseLogsByTopic: () => ({
        [reservedTopic]: [reservedLog],
        [settledTopic]: [settledLog]
      }),
      getStreamPeriods: () => []
    });

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
    assert.equal(analyticsBody.daily[0].gdStreamedWei, "0");
    assert.equal(analyticsBody.daily[0].aiCreditsUsedWei, "500000");
    assert.equal(analyticsBody.daily[0].uniqueGdBuyers, 1);
    assert.equal(analyticsBody.daily[0].uniqueCreditUsers, 1);
    assert.equal(analyticsBody.global.gdOneTimeDepositsWei, "5000000000000000000");
    assert.equal(analyticsBody.global.gdStreamedWei, "0");
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
  const dayStartUnix = Math.floor(new Date("2026-07-24T00:00:00.000Z").getTime() / 1000);
  const dayEndUnix = dayStartUnix + 24 * 60 * 60 - 1;

  const originalFetch = globalThis.fetch;
  try {
    const settledTopic = ChannelsEvents.getEvent("ChannelSettled")?.topicHash.toLowerCase() ?? "";
    const known = encodeChannelLog(
      "ChannelSettled",
      [channelId, knownBuyer, seller, 3_000_000n, 500_000n, 1_000_000n, 0n, "0x"],
      testEnv.ANTSEED_CHANNELS_ADDRESS!,
      `0x${"9".repeat(64)}`,
      1,
      49_970_010,
      timestamp
    );
    const unknown = encodeChannelLog(
      "ChannelSettled",
      [channelId, unknownBuyer, seller, 5_000_000n, 700_000n, 2_000_000n, 0n, "0x"],
      testEnv.ANTSEED_CHANNELS_ADDRESS!,
      `0x${"6".repeat(64)}`,
      2,
      49_970_011,
      timestamp
    );

    globalThis.fetch = buildOfflineAnalyticsFetchMock({
      dayStartUnix,
      dayEndUnix,
      celoVaultAddress: testEnv.CELO_VAULT_ADDRESS,
      baseChannelsAddress: testEnv.ANTSEED_CHANNELS_ADDRESS!,
      getCeloLogs: () => [
        {
          ...encodeVaultEventLog("GdDeposited", [account, knownBuyer, 1_000_000_000_000_000_000n, "0x"], testEnv.CELO_VAULT_ADDRESS!, `0x${"8".repeat(64)}`, 0),
          blockNumber: "0x64",
          timeStamp: `0x${timestamp.toString(16)}`
        }
      ],
      getBaseLogsByTopic: () => ({
        [settledTopic]: [known, unknown]
      }),
      getStreamPeriods: () => []
    });

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

test("analytics refresh includes base usage for buyers learned from stream userData", { concurrency: false }, async () => {
  const testEnv = env({
    CELO_VAULT_ADDRESS: "0x4Dd0136b9aabD5823cf0F65d89e8fB882C660885",
    CELO_GD_SUPERTOKEN_ADDRESS: "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A",
    CELO_BLOCKSCOUT_API_URL: "https://celo.blockscout.test/api",
    BASE_BLOCKSCOUT_API_URL: "https://base.blockscout.test/api",
    ANTSEED_CHANNELS_ADDRESS: "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d",
    SUPERFLUID_SUBGRAPH_URL: "https://superfluid.test/subgraph"
  });

  const account = "0x0000000000000000000000000000000000000abc";
  const streamBuyer = "0x0000000000000000000000000000000000000def";
  const seller = "0x0000000000000000000000000000000000000fed";
  const channelId = `0x${"5".repeat(64)}`;
  const now = new Date("2026-07-24T12:00:00.000Z");
  const timestamp = Math.floor(now.getTime() / 1000) - 60;
  const encodedBuyerUserData = `0x${"0".repeat(24)}${streamBuyer.slice(2)}`;
  const dayStartUnix = Math.floor(new Date("2026-07-24T00:00:00.000Z").getTime() / 1000);
  const dayEndUnix = dayStartUnix + 24 * 60 * 60 - 1;

  const originalFetch = globalThis.fetch;
  try {
    const settledTopic = ChannelsEvents.getEvent("ChannelSettled")?.topicHash.toLowerCase() ?? "";

    globalThis.fetch = buildOfflineAnalyticsFetchMock({
      dayStartUnix,
      dayEndUnix,
      celoVaultAddress: testEnv.CELO_VAULT_ADDRESS,
      baseChannelsAddress: testEnv.ANTSEED_CHANNELS_ADDRESS!,
      getCeloLogs: () => [],
      getBaseLogsByTopic: () => ({
        [settledTopic]: [
          encodeChannelLog(
            "ChannelSettled",
            [channelId, streamBuyer, seller, 3_000_000n, 500_000n, 1_000_000n, 0n, "0x"],
            testEnv.ANTSEED_CHANNELS_ADDRESS!,
            `0x${"c".repeat(64)}`,
            1,
            49_970_020,
            timestamp
          )
        ]
      }),
      getStreamPeriods: () => [
        {
          sender: { id: account },
          flowRate: "0",
          startedAtTimestamp: String(timestamp),
          stoppedAtTimestamp: null,
          stream: { userData: encodedBuyerUserData }
        }
      ]
    });

    await import("../src/analytics.js").then(async ({ KVAnalyticsStore, getAnalyticsWindow, runAnalyticsAggregation }) => {
      await runAnalyticsAggregation(testEnv, now);
      const analyticsBody = await getAnalyticsWindow(testEnv, 1, now);
      const buyerRegistry = await new KVAnalyticsStore(testEnv.ANTSEED_KV).getBuyerRegistry();

      assert.equal(analyticsBody.daily[0].aiCreditsUsedWei, "500000");
      assert.equal(analyticsBody.daily[0].uniqueCreditUsers, 1);
      assert.ok(buyerRegistry.has(streamBuyer.toLowerCase()));
    });
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

  const secondNow = new Date("2026-07-24T01:00:00.000Z");
  const previousDate = "2026-07-23";
  const dayStartUnix = Math.floor(new Date("2026-07-24T00:00:00.000Z").getTime() / 1000);
  const dayEndUnix = dayStartUnix + 24 * 60 * 60 - 1;

  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  try {
    // Aggregation emits verbose logs; muting console keeps this test fast and deterministic.
    console.log = (() => {}) as typeof console.log;
    console.warn = (() => {}) as typeof console.warn;
    console.error = (() => {}) as typeof console.error;

    await testEnv.ANTSEED_KV.put(
      `analytics:daily:${previousDate}`,
      JSON.stringify({
        date: previousDate,
        gdOneTimeDepositsWei: "2000000000000000000",
        gdStreamedWei: "0",
        gdTotalFlowRateWeiPerSecond: "0",
        aiCreditsUsedWei: "500000",
        uniqueGdBuyers: 1,
        uniqueCreditUsers: 1,
        updatedAt: "2026-07-23T23:59:59.000Z"
      })
    );

    globalThis.fetch = buildOfflineAnalyticsFetchMock({
      dayStartUnix,
      dayEndUnix,
      celoVaultAddress: testEnv.CELO_VAULT_ADDRESS,
      baseChannelsAddress: testEnv.ANTSEED_CHANNELS_ADDRESS!,
      getCeloLogs: () => [],
      getBaseLogsByTopic: () => ({}),
      getStreamPeriods: () => []
    });

    await import("../src/analytics.js").then(async ({ runAnalyticsAggregation }) => {
      await runAnalyticsAggregation(testEnv, secondNow);
    });

    const analyticsBody = await import("../src/analytics.js").then(async ({ getAnalyticsWindow }) => getAnalyticsWindow(testEnv, 2, secondNow));
    assert.equal(analyticsBody.global.gdOneTimeDepositsWei, "2000000000000000000");
    assert.equal(analyticsBody.global.gdStreamedWei, "0");
    assert.equal(analyticsBody.global.aiCreditsUsedWei, "500000");
    assert.equal(analyticsBody.lastRun.finalizedThroughDate, previousDate);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
  }
});

test("scheduled analytics seeds a 40-day backfill cursor on fresh KV", { concurrency: false }, async () => {
  const testEnv = env({
    BASE_BLOCKSCOUT_API_URL: "https://base.blockscout.test/api",
    CELO_BLOCKSCOUT_API_URL: "https://celo.blockscout.test/api",
    ANTSEED_CHANNELS_ADDRESS: "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d"
  });
  const now = new Date();
  const expectedFirstDate = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const expectedSecondDate = new Date(now.getTime() - 39 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const expectedCursorDate = now.toISOString().slice(0, 10);
  const dayStartUnix = Math.floor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)).getTime() / 1000);
  const dayEndUnix = dayStartUnix + 24 * 60 * 60 - 1;

  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  try {
    // Backfill runs 40 daily aggregations; muting logs keeps this test substantially faster.
    console.log = (() => {}) as typeof console.log;
    console.warn = (() => {}) as typeof console.warn;
    console.error = (() => {}) as typeof console.error;

    globalThis.fetch = buildOfflineAnalyticsFetchMock({
      dayStartUnix,
      dayEndUnix,
      baseBlockSeconds: 4,
      celoVaultAddress: undefined,
      baseChannelsAddress: testEnv.ANTSEED_CHANNELS_ADDRESS!,
      getStreamPeriods: () => []
    });

    const event = { scheduledTime: now.getTime(), cron: "0 */6 * * *" } as unknown as ScheduledEvent;
    const ctx = makeExecutionContext();
    await worker.scheduled(event, testEnv, ctx);

    const firstDaily = await testEnv.ANTSEED_KV.get(`analytics:daily:${expectedFirstDate}`, "json");
    const secondDaily = await testEnv.ANTSEED_KV.get(`analytics:daily:${expectedSecondDate}`, "json");
    const cursor = await testEnv.ANTSEED_KV.get("analytics:cron:backfill-cursor");

    assert.notEqual(firstDaily, null);
    assert.notEqual(secondDaily, null);
    assert.equal(cursor, expectedCursorDate);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
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
  const dayStartUnix = Math.floor(new Date("2026-07-24T00:00:00.000Z").getTime() / 1000);
  const dayEndUnix = dayStartUnix + 24 * 60 * 60 - 1;
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
    globalThis.fetch = buildOfflineAnalyticsFetchMock({
      dayStartUnix,
      dayEndUnix,
      explorerFromBlock: 100,
      explorerToBlock: 100 + totalLogs - 1,
      celoVaultAddress: testEnv.CELO_VAULT_ADDRESS,
      baseChannelsAddress: testEnv.ANTSEED_CHANNELS_ADDRESS!,
      getCeloLogs: () => celoLogs,
      getStreamPeriods: () => []
    });

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
    makeExecutionContext()
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
    makeExecutionContext()
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
      body: JSON.stringify({ nonce: "0", signature: `0x${"b".repeat(130)}` })
    }),
    env(),
    makeExecutionContext()
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
    makeExecutionContext()
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
    makeExecutionContext()
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
    makeExecutionContext()
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
    makeExecutionContext()
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
        nonce: "0",
        signature: `0x${"b".repeat(130)}`
      })
    }),
    env(),
    makeExecutionContext()
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
        nonce: "0",
        signature: `0x${"b".repeat(130)}`
      })
    }),
    env(),
    makeExecutionContext()
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { account: string; amountUsd: string; bridge: { enabled: boolean } };
  assert.equal(body.account, account);
  assert.equal(body.amountUsd, "5000000");
  assert.equal(body.bridge.enabled, false);
});

test("/v1/celo/events/record processes StreamUpdated logs into stream credits", { concurrency: false }, async () => {
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
      makeExecutionContext()
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

test("/v1/celo/events/record marks zero totalFlowWei StreamUpdated as funded without Base deposit", { concurrency: false }, async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000aaa";
  const txHash = `0x${"5".repeat(64)}`;
  const celoVault = "0x0000000000000000000000000000000000000def";
  const goodIdAddr = "0x0000000000000000000000000000000000001234";
  const originalFetch = globalThis.fetch;

  try {
    const testEnv = env({
      CELO_RPC_URL: "https://celo.rpc.local",
      CELO_VAULT_ADDRESS: celoVault,
      CELO_GOODID_ADDRESS: goodIdAddr,
      ANTSEED_FUNDING_RPC_URL: "https://base.rpc.local",
      ANTSEED_FUNDING_VAULT_ADDRESS: "0x0000000000000000000000000000000000000b01",
      ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY: "0x" + "1".repeat(64)
    });

    const streamLog = encodeVaultEventLog("StreamUpdated", [account, buyer, 385_802_469_136n, 1_000_000_000_000_000_000n, 0n], celoVault, txHash, 0);

    let baseRpcCalls = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("base.rpc.local")) {
        baseRpcCalls += 1;
        return Response.json({ jsonrpc: "2.0", id: 1, result: "0x0" });
      }
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_call") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: "0x000000000000000000000000abababababababababababababababababababab"
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { logs: [streamLog] } });
    }) as typeof fetch;

    const res = await worker.fetch(
      new Request("https://worker.test/v1/celo/events/record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash })
      }),
      testEnv,
      makeExecutionContext()
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      events: Array<{
        source: string;
        fundingStatus: string;
        gdAmountWei: string;
        principalUsd: string;
        bonusUsd: string;
        fundingError?: string;
        fundingTxHash?: string;
        bridge?: { amountUsd?: string; txHash?: string };
      }>;
    };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].source, "streamUpdate");
    assert.equal(body.events[0].fundingStatus, "funded");
    assert.equal(body.events[0].gdAmountWei, "0");
    assert.equal(body.events[0].principalUsd, "0");
    assert.equal(body.events[0].bonusUsd, "0");
    assert.equal(body.events[0].fundingError, undefined);
    assert.equal(body.events[0].fundingTxHash, undefined);
    assert.equal(body.events[0].bridge?.amountUsd, "0");
    assert.equal(body.events[0].bridge?.txHash, undefined);
    assert.equal(baseRpcCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/v1/celo/events/record skips zero-amount deposit credits", { concurrency: false }, async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000aaa";
  const txHash = `0x${"6".repeat(64)}`;
  const celoVault = "0x0000000000000000000000000000000000000def";
  const originalFetch = globalThis.fetch;

  try {
    const testEnv = env({ CELO_RPC_URL: "https://celo.rpc.local", CELO_VAULT_ADDRESS: celoVault });
    const depositLog = encodeVaultEventLog("GdDeposited", [account, buyer, 0n, "0x"], celoVault, txHash, 0);

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_call") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: "0x0000000000000000000000000000000000000000000000000000000000000000"
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { logs: [depositLog] } });
    }) as typeof fetch;

    const res = await worker.fetch(
      new Request("https://worker.test/v1/celo/events/record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash })
      }),
      testEnv,
      makeExecutionContext()
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as { events: unknown[] };
    assert.equal(body.events.length, 0);

    const historyRes = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/credit-history`), testEnv, makeExecutionContext());
    assert.equal(historyRes.status, 200);
    const historyBody = (await historyRes.json()) as { items: unknown[] };
    assert.equal(historyBody.items.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/v1/celo/events/record processes account+fromBlock range query", { concurrency: false }, async () => {
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
      makeExecutionContext()
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
    makeExecutionContext()
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

test("fundCredit skips bonus-only credits without calling Base funding when buyer revoked operator", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000aaa";
  const kv = new MemoryKV();
  const store = new KVCreditStore(kv as never);
  const entry: GdCreditEntry = {
    id: "stream:bonus-only:test",
    account: account.toLowerCase(),
    rootAccount: account.toLowerCase(),
    source: "streamUpdate",
    gdAmountWei: "0",
    principalUsd: "0",
    bonusUsd: "40",
    totalCreditUsd: "40",
    fundingStatus: "pending",
    createdAt: new Date().toISOString(),
    streamUpdateMonth: "2026-08",
    buyerAddress: buyer.toLowerCase()
  };
  await kv.put(`user:${account.toLowerCase()}`, JSON.stringify({ account: account.toLowerCase(), totalOutstandingFundingUsd: "40" }));

  let depositCalls = 0;
  const vault = {
    enabled: true,
    async isBuyerOperator() {
      return { enabled: true, buyer: buyer.toLowerCase(), isOperator: false };
    },
    async depositForBuyerWithId() {
      depositCalls += 1;
      throw new Error("deposit should not be called");
    }
  };

  const result = await fundCredit(entry, store, vault as never);
  const updatedEntry = (await kv.get("gd-credit:stream:bonus-only:test", "json")) as GdCreditEntry;
  const profile = (await kv.get(`user:${account.toLowerCase()}`, "json")) as { totalOutstandingFundingUsd: string; totalBonusUsd: string };

  assert.equal(depositCalls, 0);
  assert.equal(updatedEntry.fundingStatus, "funded");
  assert.equal(updatedEntry.fundingTxHash, undefined);
  assert.equal(profile.totalOutstandingFundingUsd, "0");
  assert.equal(profile.totalBonusUsd, "0");
  assert.deepEqual(result.bridge, { enabled: true, buyer: buyer.toLowerCase(), amountUsd: "40" });
});

test("fundCredit deposits bonus-only credits when buyer still uses operator", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000aaa";
  const kv = new MemoryKV();
  const store = new KVCreditStore(kv as never);
  const entry: GdCreditEntry = {
    id: "stream:bonus-only:operator:test",
    account: account.toLowerCase(),
    rootAccount: account.toLowerCase(),
    source: "streamUpdate",
    gdAmountWei: "0",
    principalUsd: "0",
    bonusUsd: "40",
    totalCreditUsd: "40",
    fundingStatus: "pending",
    createdAt: new Date().toISOString(),
    streamUpdateMonth: "2026-08",
    buyerAddress: buyer.toLowerCase()
  };
  await kv.put(`user:${account.toLowerCase()}`, JSON.stringify({ account: account.toLowerCase(), totalOutstandingFundingUsd: "40" }));

  let depositCalls = 0;
  const vault = {
    enabled: true,
    async isBuyerOperator() {
      return { enabled: true, buyer: buyer.toLowerCase(), isOperator: true };
    },
    async depositForBuyerWithId(_buyer: string, principalUsd: bigint, bonusUsd: bigint, id: string) {
      depositCalls += 1;
      assert.equal(_buyer, buyer.toLowerCase());
      assert.equal(principalUsd, 0n);
      assert.equal(bonusUsd, 40n);
      assert.equal(id, entry.id);
      return { enabled: true, buyer: _buyer, amountUsd: "40", txHash: "0xfunded" };
    }
  };

  const result = await fundCredit(entry, store, vault as never);
  const updatedEntry = (await kv.get("gd-credit:stream:bonus-only:operator:test", "json")) as GdCreditEntry;
  const profile = (await kv.get(`user:${account.toLowerCase()}`, "json")) as { totalOutstandingFundingUsd: string; totalBonusUsd: string };

  assert.equal(depositCalls, 1);
  assert.equal(updatedEntry.fundingStatus, "funded");
  assert.equal(updatedEntry.fundingTxHash, "0xfunded");
  assert.equal(profile.totalOutstandingFundingUsd, "0");
  assert.equal(profile.totalBonusUsd, "40");
  assert.deepEqual(result.bridge, { enabled: true, buyer: buyer.toLowerCase(), amountUsd: "40", txHash: "0xfunded" });
});

test("POST /v1/accounts/:account/stream-credits rate-limits when credits issued within 24h", { concurrency: false }, async () => {
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
      makeExecutionContext()
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as { account: string; streams: unknown[]; message: string };
    assert.equal(body.streams.length, 0);
    assert.ok(body.message.includes("stream credits were issued less than"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /v1/accounts/:account/stream-credits skips streams below minimum G$ amount", { concurrency: false }, async () => {
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
      makeExecutionContext()
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
