import test from "node:test";
import assert from "node:assert/strict";
import { Interface, Wallet } from "ethers";
import worker, { fundCredit, streamElapsedSeconds } from "../src/worker.js";
import { AntSeedFundingVaultClient } from "../src/antseed-funding-vault.js";
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

test("POST /v1/accounts/:account/operator-revoke returns 400 on missing body fields", async () => {
  const buyer = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${buyer}/operator-revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    }),
    env(),
    makeExecutionContext()
  );
  assert.equal(res.status, 400);
});

test("POST /v1/accounts/:account/operator-revoke returns enabled:false when vault not configured", async () => {
  const buyer = "0x0000000000000000000000000000000000000abc";
  const res = await worker.fetch(
    new Request(`https://worker.test/v1/accounts/${buyer}/operator-revoke`, {
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
  const body = (await res.json()) as { buyer: string; bridge: { enabled: boolean; nonce: string } };
  assert.equal(body.buyer, buyer);
  assert.equal(body.bridge.enabled, false);
  assert.equal(body.bridge.nonce, "0");
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

test("/v1/celo/events/record credits the owed window, not the event's totalFlowWei", { concurrency: false }, async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000aaa";
  const txHash = `0x${"3".repeat(64)}`;
  const celoVault = "0x0000000000000000000000000000000000000def";
  const goodIdAddr = "0x0000000000000000000000000000000000001234";
  const originalFetch = globalThis.fetch;

  // The previously recorded rate, and a credit one day old. The event's own `totalFlowWei` is
  // measured from the last on-chain flow change and overlaps this window, so it must not be used.
  const previousFlowRate = 385_802_469_136n;
  const lastStreamCreditAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const kv = new MemoryKV();
    await kv.put(
      `user:${account.toLowerCase()}`,
      JSON.stringify({
        account: account.toLowerCase(),
        rootAccount: account.toLowerCase(),
        createdAt: lastStreamCreditAt,
        updatedAt: lastStreamCreditAt,
        totalGdDepositedWei: "0",
        totalBonusUsd: "0",
        streamFlowRateWeiPerSecond: previousFlowRate.toString(),
        totalPrincipalUsd: "0",
        totalGDStreamedWei: "0",
        totalOutstandingFundingUsd: "0",
        lastStreamCreditAt
      })
    );

    const testEnv = env({
      ANTSEED_KV: kv as never,
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
      events: Array<{ source: string; fundingStatus: string; gdAmountWei: string; principalUsd: string; bonusUsd: string; buyerAddress?: string }>;
    };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].source, "streamUpdate");
    assert.equal(body.events[0].fundingStatus, "funded");
    assert.equal(body.events[0].buyerAddress, buyer.toLowerCase());

    // The owed window is one day at the previously recorded rate. Allow a few seconds of slack for
    // wall-clock drift between seeding the profile and the request being handled.
    const credited = BigInt(body.events[0].gdAmountWei);
    const expected = previousFlowRate * BigInt(24 * 60 * 60);
    const drift = credited > expected ? credited - expected : expected - credited;
    assert.ok(drift <= previousFlowRate * 10n, `credited ${credited}, expected ~${expected}`);

    // And emphatically not the event's own figure.
    assert.notEqual(body.events[0].gdAmountWei, "2000000000000000000");

    // verified + stream source → 20% bonus on whatever principal the window produced
    const principalUsd = BigInt(body.events[0].principalUsd);
    assert.ok(principalUsd > 0n);
    assert.equal(BigInt(body.events[0].bonusUsd), (principalUsd * 20n) / 100n);
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

test("/v1/celo/events/record sets stream bonus to 0 when buyer revoked operator", { concurrency: false }, async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000aaa";
  const txHash = `0x${"7".repeat(64)}`;
  const celoVault = "0x0000000000000000000000000000000000000def";
  const goodIdAddr = "0x0000000000000000000000000000000000001234";
  const originalFetch = globalThis.fetch;
  const originalIsBuyerOperator = AntSeedFundingVaultClient.prototype.isBuyerOperator;
  const originalDepositForBuyerWithId = AntSeedFundingVaultClient.prototype.depositForBuyerWithId;

  let depositCalls = 0;
  const previousFlowRate = 385_802_469_136n;
  const lastStreamCreditAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    // A stream credit is now the owed window at the previously recorded rate, so the profile needs
    // both before a StreamUpdated event can produce a non-zero principal.
    const kv = new MemoryKV();
    await kv.put(
      `user:${account.toLowerCase()}`,
      JSON.stringify({
        account: account.toLowerCase(),
        rootAccount: account.toLowerCase(),
        createdAt: lastStreamCreditAt,
        updatedAt: lastStreamCreditAt,
        totalGdDepositedWei: "0",
        totalBonusUsd: "0",
        streamFlowRateWeiPerSecond: previousFlowRate.toString(),
        totalPrincipalUsd: "0",
        totalGDStreamedWei: "0",
        totalOutstandingFundingUsd: "0",
        lastStreamCreditAt
      })
    );

    const testEnv = env({
      ANTSEED_KV: kv as never,
      CELO_RPC_URL: "https://celo.rpc.local",
      CELO_VAULT_ADDRESS: celoVault,
      CELO_GOODID_ADDRESS: goodIdAddr,
      ANTSEED_FUNDING_RPC_URL: "https://base.rpc.local",
      ANTSEED_FUNDING_VAULT_ADDRESS: "0x0000000000000000000000000000000000000b01",
      ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY: Wallet.createRandom().privateKey
    });

    const streamLog = encodeVaultEventLog(
      "StreamUpdated",
      [account, buyer, 385_802_469_136n, 1_000_000_000_000_000_000n, 2_000_000_000_000_000_000n],
      celoVault,
      txHash,
      0
    );

    AntSeedFundingVaultClient.prototype.isBuyerOperator = async function (operatorBuyer: string) {
      return { enabled: true, buyer: operatorBuyer.toLowerCase(), isOperator: false };
    };

    AntSeedFundingVaultClient.prototype.depositForBuyerWithId = async function (operatorBuyer: string, principalUsd: bigint, bonusUsd: bigint) {
      depositCalls += 1;
      assert.equal(operatorBuyer, buyer.toLowerCase());
      assert.ok(principalUsd > 0n, "principal is still deposited when the operator is revoked");
      assert.equal(bonusUsd, 0n, "revoked operator must zero the bonus");
      return { enabled: true, buyer: operatorBuyer, amountUsd: principalUsd.toString(), txHash: "0xfunded" };
    };

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
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
      events: Array<{ source: string; fundingStatus: string; principalUsd: string; bonusUsd: string; buyerAddress?: string }>;
    };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].source, "streamUpdate");
    assert.equal(body.events[0].fundingStatus, "funded");
    assert.ok(BigInt(body.events[0].principalUsd) > 0n);
    assert.equal(body.events[0].bonusUsd, "0");
    assert.equal(body.events[0].buyerAddress, buyer.toLowerCase());
    assert.equal(depositCalls, 1);
  } finally {
    AntSeedFundingVaultClient.prototype.isBuyerOperator = originalIsBuyerOperator;
    AntSeedFundingVaultClient.prototype.depositForBuyerWithId = originalDepositForBuyerWithId;
    globalThis.fetch = originalFetch;
  }
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
                createdAtTimestamp: "1735000000",
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
                createdAtTimestamp: "1735000000",
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

test("streamElapsedSeconds measures from the last credit when one exists", () => {
  const now = new Date("2026-09-11T06:00:00.000Z");
  const elapsed = streamElapsedSeconds(now, "2026-09-10T06:00:00.000Z", "2026-07-02T00:00:00.000Z");
  assert.equal(elapsed, 24 * 60 * 60);
});

test("streamElapsedSeconds falls back to the stream's last on-chain update on the first credit", () => {
  const now = new Date("2026-07-03T00:00:00.000Z");
  const elapsed = streamElapsedSeconds(now, undefined, "2026-07-02T00:00:00.000Z");
  assert.equal(elapsed, 24 * 60 * 60);
});

// A long gap is legitimate -- a stalled cron or a backfill -- and the stream really did flow for
// all of it, so the full window is credited rather than capped.
test("streamElapsedSeconds credits the whole window for a long gap", () => {
  const now = new Date("2026-09-11T06:00:00.000Z");
  const elapsed = streamElapsedSeconds(now, "2026-01-01T00:00:00.000Z", "2025-06-01T00:00:00.000Z");
  assert.equal(elapsed, Math.floor((Date.parse("2026-09-11T06:00:00.000Z") - Date.parse("2026-01-01T00:00:00.000Z")) / 1000));
});

// Regression, from account 0x2ceade86...0627: stream a-0.0 ran 07-02 -> 07-06, then nothing flowed
// for 53 days, then a new revision a-1.0 opened on 08-28. `lastStreamCreditAt` survives the close,
// so without the creation floor the dormant gap gets credited at the new stream's rate.
test("streamElapsedSeconds does not credit the gap before a re-opened stream", () => {
  const now = new Date("2026-08-29T06:00:00.000Z");
  const lastCreditOnClosedStream = "2026-07-02T18:24:14.244Z";
  const reopenedAt = "2026-08-28T15:18:07.000Z";

  const elapsed = streamElapsedSeconds(now, lastCreditOnClosedStream, reopenedAt);
  assert.equal(elapsed, Math.floor((now.getTime() - Date.parse(reopenedAt)) / 1000));

  const flowRateWeiPerSecond = 3433641975308641n; // 8900 G$/month
  const credited = flowRateWeiPerSecond * BigInt(elapsed);
  assert.ok(credited < 200n * 10n ** 18n, `expected under 200 G$, got ${credited}`);

  // Without the floor the baseline would have been the pre-close credit, 57 days earlier.
  const unflooredElapsed = Math.floor((now.getTime() - Date.parse(lastCreditOnClosedStream)) / 1000);
  assert.ok(flowRateWeiPerSecond * BigInt(unflooredElapsed) > 16_000n * 10n ** 18n);
});

// Regression: a 1970 baseline made elapsedSeconds the whole Unix epoch, so a 9000 G$/month stream
// was credited 6.19M G$ (~$730) in a single entry.
test("streamElapsedSeconds rejects an epoch-zero baseline instead of crediting 56 years", () => {
  const now = new Date("2026-07-02T18:22:51.590Z");
  const elapsed = streamElapsedSeconds(now, undefined, "1970-01-01T00:00:00.000Z");
  assert.equal(elapsed, 0);

  const flowRateWeiPerSecond = (9000n * 10n ** 18n) / 2592000n;
  assert.equal(flowRateWeiPerSecond * BigInt(elapsed), 0n);
  // What the old code produced for this exact account:
  assert.equal(flowRateWeiPerSecond * BigInt(Math.floor(now.getTime() / 1000)), 6191029760416666270440762n);
});

test("streamElapsedSeconds rejects an unparseable baseline", () => {
  const now = new Date("2026-09-11T06:00:00.000Z");
  assert.equal(streamElapsedSeconds(now, undefined, "not-a-date"), 0);
});

test("streamElapsedSeconds never returns a negative window", () => {
  const now = new Date("2026-07-02T00:00:00.000Z");
  assert.equal(streamElapsedSeconds(now, "2026-09-11T06:00:00.000Z", "2026-07-02T00:00:00.000Z"), 0);
});

// Regression: the subgraph returning `updatedAtTimestamp: "0"` used to become a 1970 baseline,
// which credited the whole Unix epoch of stream in one entry.
test("POST /v1/accounts/:account/stream-credits does not credit the epoch on a zero subgraph timestamp", { concurrency: false }, async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const celoVault = "0x0000000000000000000000000000000000000def";
  const gdSuperToken = "0x0000000000000000000000000000000000000fed";
  const originalFetch = globalThis.fetch;

  try {
    const kv = new MemoryKV();
    const testEnv = env({
      ANTSEED_KV: kv as never,
      CELO_VAULT_ADDRESS: celoVault,
      CELO_GD_SUPERTOKEN_ADDRESS: gdSuperToken
    });

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.query) {
        return Response.json({
          data: {
            streams: [
              {
                sender: { id: account },
                currentFlowRate: "3472222222222222", // 9000 G$/month, the real account's rate
                createdAtTimestamp: "0",
                updatedAtTimestamp: "0",
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
    const store = new KVCreditStore(kv as never);
    const credits = await store.getGdCredits(account);
    assert.equal(credits.length, 0, "a zero subgraph timestamp must not produce a credit entry");
    const profile = await store.getUser(account);
    assert.equal(profile.totalGdDepositedWei, "0");
    assert.equal(profile.totalGDStreamedWei, "0");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Regression, from account 0x2ceade86...0627: stream a-0.0 closed 2026-07-06, a-1.0 opened
// 2026-08-28. `lastStreamCreditAt` survives the close, so the opening event must not bill the
// 53-day dormant gap. Termination records flowRate 0, which zeroes the owed window and lets the
// funding path re-baseline the clock to now.
test("/v1/celo/events/record re-baselines on stream start instead of billing the dormant gap", { concurrency: false }, async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000aaa";
  const txHash = `0x${"9".repeat(64)}`;
  const celoVault = "0x0000000000000000000000000000000000000def";
  const goodIdAddr = "0x0000000000000000000000000000000000001234";
  const originalFetch = globalThis.fetch;

  const closedAt = new Date(Date.now() - 53 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const kv = new MemoryKV();
    // Profile as it looks after a termination: clock 53 days stale, recorded rate zeroed.
    await kv.put(
      `user:${account.toLowerCase()}`,
      JSON.stringify({
        account: account.toLowerCase(),
        rootAccount: account.toLowerCase(),
        createdAt: closedAt,
        updatedAt: closedAt,
        totalGdDepositedWei: "0",
        totalBonusUsd: "0",
        streamFlowRateWeiPerSecond: "0",
        totalPrincipalUsd: "0",
        totalGDStreamedWei: "0",
        totalOutstandingFundingUsd: "0",
        lastStreamCreditAt: closedAt
      })
    );

    const testEnv = env({
      ANTSEED_KV: kv as never,
      CELO_RPC_URL: "https://celo.rpc.local",
      CELO_VAULT_ADDRESS: celoVault,
      CELO_GOODID_ADDRESS: goodIdAddr
    });

    // Stream creation: totalFlowWei is always 0 because there was no previous flow.
    const creationLog = encodeVaultEventLog("StreamUpdated", [account, buyer, 3_433_641_975_308_641n, 8_900_000_000_000_000_000_000n, 0n], celoVault, txHash, 0);

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_call") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x000000000000000000000000abababababababababababababababababababab" });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { logs: [creationLog] } });
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
    const body = (await res.json()) as { events: Array<{ gdAmountWei: string; principalUsd: string; fundingStatus: string }> };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].gdAmountWei, "0", "the dormant gap must not be credited");
    assert.equal(body.events[0].principalUsd, "0");
    assert.equal(body.events[0].fundingStatus, "funded");

    const store = new KVCreditStore(kv as never);
    const profile = await store.getUser(account);
    // Clock re-baselined to now, and the new stream's rate adopted for the next window.
    assert.ok(Date.parse(profile.lastStreamCreditAt!) > Date.parse(closedAt));
    assert.ok(Date.now() - Date.parse(profile.lastStreamCreditAt!) < 60_000);
    assert.equal(profile.streamFlowRateWeiPerSecond, "3433641975308641");
    assert.equal(profile.totalGDStreamedWei, "0");

    // What the unfixed path would have billed: 53 days at the closed stream's old rate.
    const staleRate = 3_433_641_975_308_641n;
    assert.ok(staleRate * BigInt(53 * 24 * 60 * 60) > 15_000n * 10n ** 18n);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The floor must not depend on the close having been ingested. Here the profile still carries the
// closed stream's rate (the termination event never arrived), and only the subgraph's
// `createdAtTimestamp` prevents the opening event from billing the 53-day dormant gap.
test("/v1/celo/events/record floors the window at the stream's last update even with a stale flow rate", { concurrency: false }, async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000aaa";
  const txHash = `0x${"a".repeat(64)}`;
  const celoVault = "0x0000000000000000000000000000000000000def";
  const goodIdAddr = "0x0000000000000000000000000000000000001234";
  const gdSuperToken = "0x0000000000000000000000000000000000000fed";
  const originalFetch = globalThis.fetch;

  const staleRate = 3_433_641_975_308_641n; // 8900 G$/month, left over from the closed stream
  const closedAt = new Date(Date.now() - 53 * 24 * 60 * 60 * 1000).toISOString();
  const createdAtSeconds = Math.floor(Date.now() / 1000) - 60; // new stream opened a minute ago

  try {
    const kv = new MemoryKV();
    await kv.put(
      `user:${account.toLowerCase()}`,
      JSON.stringify({
        account: account.toLowerCase(),
        rootAccount: account.toLowerCase(),
        createdAt: closedAt,
        updatedAt: closedAt,
        totalGdDepositedWei: "0",
        totalBonusUsd: "0",
        streamFlowRateWeiPerSecond: staleRate.toString(), // never zeroed — close was not ingested
        totalPrincipalUsd: "0",
        totalGDStreamedWei: "0",
        totalOutstandingFundingUsd: "0",
        lastStreamCreditAt: closedAt
      })
    );

    const testEnv = env({
      ANTSEED_KV: kv as never,
      CELO_RPC_URL: "https://celo.rpc.local",
      CELO_VAULT_ADDRESS: celoVault,
      CELO_GOODID_ADDRESS: goodIdAddr,
      CELO_GD_SUPERTOKEN_ADDRESS: gdSuperToken
    });

    const creationLog = encodeVaultEventLog("StreamUpdated", [account, buyer, staleRate, 8_900_000_000_000_000_000_000n, 0n], celoVault, txHash, 0);

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.query) {
        return Response.json({
          data: {
            streams: [
              {
                sender: { id: account },
                currentFlowRate: staleRate.toString(),
                createdAtTimestamp: createdAtSeconds.toString(),
                updatedAtTimestamp: createdAtSeconds.toString(),
                flowUpdatedEvents: [{ userData: "0x" }]
              }
            ]
          }
        });
      }
      if (body.method === "eth_call") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x000000000000000000000000abababababababababababababababababababab" });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { logs: [creationLog] } });
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
    const body = (await res.json()) as { events: Array<{ gdAmountWei: string; fundingStatus: string }> };
    assert.equal(body.events.length, 1);

    // At most the ~60s since the stream opened — not the 53 days since the last credit.
    const credited = BigInt(body.events[0].gdAmountWei);
    assert.ok(credited <= staleRate * 300n, `credited ${credited}, expected at most a few minutes' worth`);
    assert.ok(staleRate * BigInt(53 * 24 * 60 * 60) > 15_000n * 10n ** 18n, "the gap would have been >15k G$");

    const store = new KVCreditStore(kv as never);
    const profile = await store.getUser(account);
    assert.ok(Date.now() - Date.parse(profile.lastStreamCreditAt!) < 60_000, "clock re-baselined to now");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The subgraph is the source of truth for whether a stream still exists. A closed stream reports
// currentFlowRate 0, and the cron must write that through — the termination event that would
// otherwise do it is pushed in by POST /v1/celo/events/record and may never arrive.
test("scheduled run zeroes the recorded flow rate once a stream closes", { concurrency: false }, async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const celoVault = "0x0000000000000000000000000000000000000def";
  const gdSuperToken = "0x0000000000000000000000000000000000000fed";
  const staleRate = 3_433_641_975_308_641n;
  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;

  try {
    console.log = (() => {}) as typeof console.log;
    const kv = new MemoryKV();
    await kv.put(
      `user:${account}`,
      JSON.stringify({
        account,
        rootAccount: account,
        createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        totalGdDepositedWei: "0",
        totalBonusUsd: "0",
        streamFlowRateWeiPerSecond: staleRate.toString(),
        totalPrincipalUsd: "0",
        totalGDStreamedWei: "0",
        totalOutstandingFundingUsd: "0",
        lastStreamCreditAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
      })
    );

    const testEnv = env({ ANTSEED_KV: kv as never, CELO_VAULT_ADDRESS: celoVault, CELO_GD_SUPERTOKEN_ADDRESS: gdSuperToken });
    const createdAtSeconds = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.query?.includes("streams")) {
        // Two revisions for one account, both closed — the shape the live subgraph returns.
        return Response.json({
          data: {
            streams: [0, 1].map((revision) => ({
              sender: { id: account },
              currentFlowRate: "0",
              createdAtTimestamp: (createdAtSeconds + revision * 1000).toString(),
              updatedAtTimestamp: (createdAtSeconds + revision * 2000).toString(),
              flowUpdatedEvents: [{ userData: "0x" }]
            }))
          }
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x" });
    }) as typeof fetch;

    await worker.scheduled({ scheduledTime: Date.now(), cron: "0 */6 * * *" } as unknown as ScheduledEvent, testEnv, makeExecutionContext());

    const profile = await new KVCreditStore(kv as never).getUser(account);
    assert.equal(profile.streamFlowRateWeiPerSecond, "0", "a closed stream must not keep advertising its rate");
    // Current state only — the clock and the totals are settlement, and must not move here.
    assert.equal(profile.totalGDStreamedWei, "0");
    assert.equal(profile.totalPrincipalUsd, "0");
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
  }
});

// One account can hold a closed revision and a live one at the same time. Summing per account is
// what stops the closed row from clobbering the live rate, whatever order the subgraph returns them.
test("scheduled run keeps the live rate when an account also has a closed revision", { concurrency: false }, async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const celoVault = "0x0000000000000000000000000000000000000def";
  const gdSuperToken = "0x0000000000000000000000000000000000000fed";
  const liveRate = 3_433_641_975_308_641n;
  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;

  try {
    console.log = (() => {}) as typeof console.log;
    const kv = new MemoryKV();
    // The sync only corrects accounts that already have a profile, and a stale value here proves the
    // closed revision does not win over the live one.
    await kv.put(
      `user:${account}`,
      JSON.stringify({
        account,
        rootAccount: account,
        createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        totalGdDepositedWei: "0",
        totalBonusUsd: "0",
        streamFlowRateWeiPerSecond: "1",
        totalPrincipalUsd: "0",
        totalGDStreamedWei: "0",
        totalOutstandingFundingUsd: "0",
        lastStreamCreditAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
      })
    );
    const testEnv = env({ ANTSEED_KV: kv as never, CELO_VAULT_ADDRESS: celoVault, CELO_GD_SUPERTOKEN_ADDRESS: gdSuperToken });
    const nowSeconds = Math.floor(Date.now() / 1000);

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.query?.includes("streams")) {
        return Response.json({
          data: {
            streams: [
              // Live revision first, closed one after it — the clobbering order.
              {
                sender: { id: account },
                currentFlowRate: liveRate.toString(),
                createdAtTimestamp: (nowSeconds - 3600).toString(),
                updatedAtTimestamp: (nowSeconds - 3600).toString(),
                flowUpdatedEvents: [{ userData: "0x" }]
              },
              {
                sender: { id: account },
                currentFlowRate: "0",
                createdAtTimestamp: (nowSeconds - 90 * 24 * 3600).toString(),
                updatedAtTimestamp: (nowSeconds - 60 * 24 * 3600).toString(),
                flowUpdatedEvents: [{ userData: "0x" }]
              }
            ]
          }
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x" });
    }) as typeof fetch;

    await worker.scheduled({ scheduledTime: Date.now(), cron: "0 */6 * * *" } as unknown as ScheduledEvent, testEnv, makeExecutionContext());

    const profile = await new KVCreditStore(kv as never).getUser(account);
    assert.equal(profile.streamFlowRateWeiPerSecond, liveRate.toString());
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
  }
});

// The scheduled run corrects state that exists; it must not enrol a streamer who has never been
// credited. Their first credit is what creates the profile, in `recordGdCredit`.
test("scheduled run does not create a profile for an uncredited streamer", { concurrency: false }, async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const celoVault = "0x0000000000000000000000000000000000000def";
  const gdSuperToken = "0x0000000000000000000000000000000000000fed";
  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;

  try {
    console.log = (() => {}) as typeof console.log;
    const kv = new MemoryKV();
    const testEnv = env({ ANTSEED_KV: kv as never, CELO_VAULT_ADDRESS: celoVault, CELO_GD_SUPERTOKEN_ADDRESS: gdSuperToken });
    const nowSeconds = Math.floor(Date.now() / 1000);

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.query?.includes("streams")) {
        return Response.json({
          data: {
            streams: [
              {
                sender: { id: account },
                currentFlowRate: "3433641975308641",
                createdAtTimestamp: (nowSeconds - 3600).toString(),
                updatedAtTimestamp: (nowSeconds - 3600).toString(),
                flowUpdatedEvents: [{ userData: "0x" }]
              }
            ]
          }
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x" });
    }) as typeof fetch;

    await worker.scheduled({ scheduledTime: Date.now(), cron: "0 */6 * * *" } as unknown as ScheduledEvent, testEnv, makeExecutionContext());

    assert.equal(await kv.get(`user:${account}`), null, "no profile may be written by the sync alone");
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
  }
});

// A GoodID root aggregates its identity's wallets. The lifetime totals get there by mirroring in
// `updateUser`, which works because they accumulate; a flow rate is absolute, so it is summed.
test("scheduled run sums the flow rate across a root's accounts", { concurrency: false }, async () => {
  const rootAccount = "0x0000000000000000000000000000000000000a00";
  const walletA = "0x0000000000000000000000000000000000000a01";
  const walletB = "0x0000000000000000000000000000000000000a02";
  const celoVault = "0x0000000000000000000000000000000000000def";
  const gdSuperToken = "0x0000000000000000000000000000000000000fed";
  const rateA = 1_000_000_000_000_000n;
  const rateB = 2_000_000_000_000_000n;
  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;

  try {
    console.log = (() => {}) as typeof console.log;
    const kv = new MemoryKV();
    const seed = (account: string, root: string) =>
      kv.put(
        `user:${account}`,
        JSON.stringify({
          account,
          rootAccount: root,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          totalGdDepositedWei: "0",
          totalBonusUsd: "0",
          streamFlowRateWeiPerSecond: "0",
          totalPrincipalUsd: "0",
          totalGDStreamedWei: "0",
          totalOutstandingFundingUsd: "0",
          lastStreamCreditAt: undefined
        })
      );
    await seed(walletA, rootAccount);
    await seed(walletB, rootAccount);
    await seed(rootAccount, rootAccount);

    const testEnv = env({ ANTSEED_KV: kv as never, CELO_VAULT_ADDRESS: celoVault, CELO_GD_SUPERTOKEN_ADDRESS: gdSuperToken });
    const nowSeconds = Math.floor(Date.now() / 1000);

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.query?.includes("streams")) {
        return Response.json({
          data: {
            streams: [
              [walletA, rateA],
              [walletB, rateB]
            ].map(([sender, rate]) => ({
              sender: { id: sender as string },
              currentFlowRate: (rate as bigint).toString(),
              createdAtTimestamp: (nowSeconds - 3600).toString(),
              updatedAtTimestamp: (nowSeconds - 3600).toString(),
              flowUpdatedEvents: [{ userData: "0x" }]
            }))
          }
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x" });
    }) as typeof fetch;

    await worker.scheduled({ scheduledTime: Date.now(), cron: "0 */6 * * *" } as unknown as ScheduledEvent, testEnv, makeExecutionContext());

    const store = new KVCreditStore(kv as never);
    // Each wallet keeps its own rate — it is the pricing input for that account's stream updates.
    assert.equal((await store.getUser(walletA)).streamFlowRateWeiPerSecond, rateA.toString());
    assert.equal((await store.getUser(walletB)).streamFlowRateWeiPerSecond, rateB.toString());
    // The root carries the identity's total, not whichever wallet synced last.
    assert.equal((await store.getUser(rootAccount)).streamFlowRateWeiPerSecond, (rateA + rateB).toString());
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
  }
});

// ---------------------------------------------------------------------------
// Scheduled run: credit issuance across the stream lifecycle.
//
// These drive `flowRate * elapsed -> recordGdCredit` through `scheduled` and assert the credit
// entry. Funding is fired through `ctx.waitUntil`, which the test harness discards, so the entry --
// not the funding result -- is the observable, and it is the part that was wrong in production.
// ---------------------------------------------------------------------------

const CRON_EVENT = { scheduledTime: 0, cron: "0 */6 * * *" } as unknown as ScheduledEvent;
const RATE_8900 = 3_433_641_975_308_641n; // 8900 G$/month, ~296.67 G$/day
const MIN_CREDIT_WEI = 4_000n * 10n ** 18n; // MIN_GD_STREAMED_FOR_BONUS default

function seedStreamProfile(kv: MemoryKV, account: string, fields: { flowRate: bigint; lastStreamCreditAt?: string }) {
  const stamp = fields.lastStreamCreditAt ?? new Date().toISOString();
  return kv.put(
    `user:${account}`,
    JSON.stringify({
      account,
      rootAccount: account,
      createdAt: stamp,
      updatedAt: stamp,
      totalGdDepositedWei: "0",
      totalBonusUsd: "0",
      streamFlowRateWeiPerSecond: fields.flowRate.toString(),
      totalPrincipalUsd: "0",
      totalGDStreamedWei: "0",
      totalOutstandingFundingUsd: "0",
      lastStreamCreditAt: fields.lastStreamCreditAt
    })
  );
}

function subgraphStream(account: string, flowRate: bigint, createdAtSeconds: number, updatedAtSeconds = createdAtSeconds) {
  return {
    sender: { id: account },
    currentFlowRate: flowRate.toString(),
    createdAtTimestamp: createdAtSeconds.toString(),
    updatedAtTimestamp: updatedAtSeconds.toString(),
    flowUpdatedEvents: [{ userData: "0x" }]
  };
}

function cronFetchMock(streams: unknown[]) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.query?.includes("streams")) return Response.json({ data: { streams } });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x" });
  }) as typeof fetch;
}

async function runCron(kv: MemoryKV, streams: unknown[]) {
  const testEnv = env({
    ANTSEED_KV: kv as never,
    CELO_VAULT_ADDRESS: "0x0000000000000000000000000000000000000def",
    CELO_GD_SUPERTOKEN_ADDRESS: "0x0000000000000000000000000000000000000fed"
  });
  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;
  try {
    console.log = (() => {}) as typeof console.log;
    globalThis.fetch = cronFetchMock(streams);
    await worker.scheduled(CRON_EVENT, testEnv, makeExecutionContext());
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
  }
  return new KVCreditStore(kv as never);
}

test("scheduled run issues no credit for a closed stream", { concurrency: false }, async () => {
  const account = "0x0000000000000000000000000000000000000ac1";
  const kv = new MemoryKV();
  // 30 days of uncredited time, which would be ~8900 G$ if the stream were still running.
  await seedStreamProfile(kv, account, { flowRate: RATE_8900, lastStreamCreditAt: new Date(Date.now() - 30 * 86400_000).toISOString() });
  const createdAtSeconds = Math.floor(Date.now() / 1000) - 90 * 86400;

  const store = await runCron(kv, [subgraphStream(account, 0n, createdAtSeconds, createdAtSeconds + 86400)]);

  assert.deepEqual(await store.getGdCredits(account), [], "a stream reporting currentFlowRate 0 must not be credited");
  assert.equal((await store.getUser(account)).streamFlowRateWeiPerSecond, "0");
});

test("scheduled run credits a live stream from its last credit", { concurrency: false }, async () => {
  const account = "0x0000000000000000000000000000000000000ac2";
  const kv = new MemoryKV();
  const elapsedDays = 20; // clears the 24h cooldown and the 4000 G$ minimum
  await seedStreamProfile(kv, account, { flowRate: RATE_8900, lastStreamCreditAt: new Date(Date.now() - elapsedDays * 86400_000).toISOString() });
  const createdAtSeconds = Math.floor(Date.now() / 1000) - 200 * 86400;

  const store = await runCron(kv, [subgraphStream(account, RATE_8900, createdAtSeconds)]);

  const credits = await store.getGdCredits(account);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].source, "streamCron");
  const expected = RATE_8900 * BigInt(elapsedDays * 86400);
  const credited = BigInt(credits[0].gdAmountWei);
  const drift = credited > expected ? credited - expected : expected - credited;
  assert.ok(drift <= RATE_8900 * 60n, `credited ${credited}, expected ~${expected}`);
  assert.ok(credited > MIN_CREDIT_WEI);
});

// Regression for the production incident: the stored clock was ~51 days stale while the subgraph
// still reported the stream at its opening rate, producing a single 15,244.93 G$ credit for a
// stream that had stopped flowing weeks earlier. The creation floor bounds it.
test("scheduled run bounds the credit by the stream's last update when the clock is stale", { concurrency: false }, async () => {
  const account = "0x0000000000000000000000000000000000000ac3";
  const kv = new MemoryKV();
  // Clock predates the current stream revision by seven weeks.
  await seedStreamProfile(kv, account, { flowRate: RATE_8900, lastStreamCreditAt: new Date(Date.now() - 51 * 86400_000).toISOString() });
  const reopenedDaysAgo = 20;
  const createdAtSeconds = Math.floor(Date.now() / 1000) - reopenedDaysAgo * 86400;

  const store = await runCron(kv, [subgraphStream(account, RATE_8900, createdAtSeconds)]);

  const credits = await store.getGdCredits(account);
  assert.equal(credits.length, 1);
  const credited = BigInt(credits[0].gdAmountWei);
  const sinceReopen = RATE_8900 * BigInt(reopenedDaysAgo * 86400);
  const sinceStaleClock = RATE_8900 * BigInt(51 * 86400);
  assert.ok(credited <= sinceReopen + RATE_8900 * 60n, `credited ${credited}, must not exceed the window since the stream opened`);
  assert.ok(sinceStaleClock > credited, "the unbounded window would have been materially larger");
});

test("scheduled run prices a rate change at the rate the subgraph reports", { concurrency: false }, async () => {
  const account = "0x0000000000000000000000000000000000000ac4";
  const halvedRate = RATE_8900 / 2n;
  const kv = new MemoryKV();
  // 35 days, not 20: at the halved rate a 20-day window is ~2,966 G$ and the 4000 G$ minimum would
  // skip it entirely.
  const elapsedDays = 35;
  // Profile still carries the old rate; the subgraph reports the new one.
  await seedStreamProfile(kv, account, { flowRate: RATE_8900, lastStreamCreditAt: new Date(Date.now() - elapsedDays * 86400_000).toISOString() });
  const createdAtSeconds = Math.floor(Date.now() / 1000) - 200 * 86400;

  const store = await runCron(kv, [subgraphStream(account, halvedRate, createdAtSeconds)]);

  const credits = await store.getGdCredits(account);
  assert.equal(credits.length, 1);
  const expected = halvedRate * BigInt(elapsedDays * 86400);
  const credited = BigInt(credits[0].gdAmountWei);
  const drift = credited > expected ? credited - expected : expected - credited;
  assert.ok(drift <= halvedRate * 60n, `credited ${credited}, expected ~${expected} at the new rate`);
  // And the profile adopts the new rate for the next window.
  assert.equal((await store.getUser(account)).streamFlowRateWeiPerSecond, halvedRate.toString());
});


// The distinguishing property of flooring on `updatedAtTimestamp` rather than `createdAtTimestamp`:
// a plain rate change moves the floor too. That is what makes a stale clock unreachable, and it is
// also the trade-off -- if the resulting StreamUpdated event is never ingested, the window between
// the last credit and the rate change is skipped and never paid.
test("streamElapsedSeconds floors at a rate change, not only at stream creation", () => {
  const now = new Date("2026-02-10T00:00:00.000Z");
  const lastCredit = "2026-01-15T00:00:00.000Z";
  const rateChangedAt = "2026-02-01T00:00:00.000Z";

  const elapsed = streamElapsedSeconds(now, lastCredit, rateChangedAt);
  assert.equal(elapsed, 9 * 24 * 60 * 60, "window starts at the rate change, not the last credit");

  // The 17 days between the last credit and the rate change are deliberately not included here --
  // they are the StreamUpdated event's to pay.
  const sinceLastCredit = Math.floor((now.getTime() - Date.parse(lastCredit)) / 1000);
  assert.equal(sinceLastCredit - elapsed, 17 * 24 * 60 * 60);
});

// A brief high-rate stream opened and closed between cron ticks cannot later be charged against a
// stale clock: the next stream carries a fresh on-chain update that becomes the floor.
test("streamElapsedSeconds makes a stale clock unreachable after a new stream opens", () => {
  const now = new Date("2026-02-10T00:00:00.000Z");
  const staleClock = "2026-01-10T00:00:00.000Z"; // 31 days of uncredited time
  const openedAt = "2026-02-09T22:00:00.000Z"; // new stream, two hours old

  const elapsed = streamElapsedSeconds(now, staleClock, openedAt);
  assert.equal(elapsed, 2 * 60 * 60);

  const hugeRate = 1_000_000n * 10n ** 18n; // 1M G$/second
  const credited = hugeRate * BigInt(elapsed);
  const unfloored = hugeRate * BigInt(Math.floor((now.getTime() - Date.parse(staleClock)) / 1000));
  assert.ok(unfloored / credited > 300n, "the stale window would have been orders of magnitude larger");
});
