import test from "node:test";
import assert from "node:assert/strict";
import { Interface, encodeBytes32String } from "ethers";
import { AnalyticsClient, ANTSEED_CHANNELS_ABI, DailyAnalytics } from "../src/analytics.js";
import { RuntimeConfig } from "../src/env.js";

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

  async list(options?: { prefix?: string }) {
    const prefix = options?.prefix ?? "";
    const keys = Array.from(this.data.keys())
      .filter((k) => k.startsWith(prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

function cfg(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    GD_CUSD_PRICE: 0.0001,
    MAX_BONUS_CAP_USD: 100_000_000_000_000_000_000n,
    REGULAR_BONUS_BPS: 1_000n,
    STREAMING_BONUS_BPS: 2_000n,
    MIN_STREAM_BONUS_WEI: 4_000_000_000_000_000_000_000n,
    CELO_RPC_URL: "https://celo.rpc.local",
    CELO_VAULT_ADDRESS: "0x0000000000000000000000000000000000000def",
    CELO_GD_SUPERTOKEN_ADDRESS: "0x0000000000000000000000000000000000000fed",
    SUPERFLUID_SUBGRAPH_URL: "https://superfluid.local/subgraph",
    BASE_RPC_URL: "https://base.rpc.local",
    ANTSEED_CHANNELS_ADDRESS: "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d",
    ...overrides
  } as RuntimeConfig;
}

function encodeCeloDeposit(buyer: string, amount: bigint): {
  topics: string[];
  data: string;
  blockNumber: number;
  address: string;
} {
  const event = new Interface(["event GdDeposited(address indexed account,address indexed buyer,uint256 gdAmount,bytes data)"]);
  const account = "0x0000000000000000000000000000000000000abc";
  const encoded = event.encodeEventLog(event.getEvent("GdDeposited")!, [account, buyer, amount, "0x"]);
  return {
    address: "0x0000000000000000000000000000000000000def",
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 1_000
  };
}

function encodeCeloStream(buyer: string, totalFlowWei: bigint): {
  topics: string[];
  data: string;
  blockNumber: number;
  address: string;
} {
  const event = new Interface([
    "event StreamUpdated(address indexed account,address indexed buyer,int96 flowRate,uint256 monthlyGdAmountWei,uint256 totalFlowWei)"
  ]);
  const account = "0x0000000000000000000000000000000000000abc";
  const encoded = event.encodeEventLog(event.getEvent("StreamUpdated")!, [
    account,
    buyer,
    385_802_469_136n,
    1_000_000_000_000_000_000n,
    totalFlowWei
  ]);
  return {
    address: "0x0000000000000000000000000000000000000def",
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 1_001
  };
}

function encodeBaseChannelSettled(buyer: string, settledAmount: bigint): {
  topics: string[];
  data: string;
  blockNumber: number;
  address: string;
} {
  const encoded = ANTSEED_CHANNELS_ABI.encodeEventLog(ANTSEED_CHANNELS_ABI.getEvent("ChannelSettled")!, [
    encodeBytes32String("chan1"),
    buyer,
    settledAmount
  ]);
  return {
    address: "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d",
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 5_000
  };
}

test("runAggregation groups Celo deposits and Base settlements by UTC day", async () => {
  const kv = new MemoryKV();
  const buyerA = "0x0000000000000000000000000000000000000aaa";
  const buyerB = "0x0000000000000000000000000000000000000bbb";

  const celoDeposit = encodeCeloDeposit(buyerA, 2_000_000_000_000_000_000n);
  const baseSettled = encodeBaseChannelSettled(buyerB, 500_000n);

  const testFetch = buildFetch({
    celoLogs: [celoDeposit],
    baseLogs: [baseSettled],
    latestCeloBlock: 1_000,
    latestBaseBlock: 5_000,
    celoTimestamps: { 1_000: 1_756_000_000 },
    baseTimestamps: { 5_000: 1_756_000_100 }
  });

  const client = new AnalyticsClient({ kv: kv as never, cfg: cfg(), fetch: testFetch });
  await client.runAggregation();

  const analytics = await client.getAnalytics(365);
  const targetDate = "2025-08-24";
  const day = analytics.days.find((d) => d.date === targetDate);
  assert.ok(day, `expected day ${targetDate}`);
  assert.equal(day.gdOneTimeDeposits, "2000000000000000000");
  assert.equal(day.aiCreditsUsed, "500000");
  assert.equal(day.uniqueGdBuyers, 1);
  assert.equal(day.uniqueCreditUsers, 1);
});

test("getAnalytics returns last N days defaulting to 30 and global totals", async () => {
  const kv = new MemoryKV();
  const today = utcDate(new Date());
  await kv.put(`analytics:daily:${today}`, JSON.stringify({ ...emptyDaily(today), gdOneTimeDeposits: "100" }));
  await kv.put(
    "analytics:global",
    JSON.stringify({ gdOneTimeDeposits: "100", gdStreamed: "0", gdTotalFlowRate: "0", aiCreditsUsed: "0", uniqueGdBuyers: 1, uniqueCreditUsers: 0 })
  );

  const client = new AnalyticsClient({ kv: kv as never, cfg: cfg() });
  const analytics = await client.getAnalytics();
  assert.equal(analytics.days.length, 30);
  assert.equal(analytics.days[analytics.days.length - 1].date, today);
  assert.equal(analytics.days[analytics.days.length - 1].gdOneTimeDeposits, "100");
  assert.equal(analytics.global.gdOneTimeDeposits, "100");
});

test("runAggregation resumes from lastRun and updates lastRun key", async () => {
  const kv = new MemoryKV();
  const buyer = "0x0000000000000000000000000000000000000aaa";
  const celoDeposit = encodeCeloDeposit(buyer, 1_000_000_000_000_000_000n);

  await kv.put("analytics:lastRun", JSON.stringify({ celoBlock: 999, baseBlock: 4_999, timestamp: "2025-01-01T00:00:00.000Z" }));

  const testFetch = buildFetch({
    celoLogs: [celoDeposit],
    baseLogs: [],
    latestCeloBlock: 1_001,
    latestBaseBlock: 5_001,
    celoTimestamps: { 1_000: 1_756_000_000 }
  });

  const client = new AnalyticsClient({ kv: kv as never, cfg: cfg(), fetch: testFetch });
  await client.runAggregation();

  const lastRun = await kv.get("analytics:lastRun", "json") as { celoBlock: number; baseBlock: number };
  assert.equal(lastRun.celoBlock, 1_001);
  assert.equal(lastRun.baseBlock, 5_001);
});

test("runAggregation handles empty event ranges", async () => {
  const kv = new MemoryKV();
  const testFetch = buildFetch({
    celoLogs: [],
    baseLogs: [],
    latestCeloBlock: 100,
    latestBaseBlock: 200,
    celoTimestamps: {},
    baseTimestamps: {}
  });

  const client = new AnalyticsClient({ kv: kv as never, cfg: cfg(), fetch: testFetch });
  await client.runAggregation();

  const analytics = await client.getAnalytics(1);
  assert.equal(analytics.days.length, 1);
  assert.equal(analytics.global.gdOneTimeDeposits, "0");
});

function emptyDaily(date: string): DailyAnalytics {
  return {
    date,
    gdOneTimeDeposits: "0",
    gdStreamed: "0",
    gdTotalFlowRate: "0",
    aiCreditsUsed: "0",
    uniqueGdBuyers: 0,
    uniqueCreditUsers: 0
  };
}

function utcDate(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString().slice(0, 10);
}

function buildFetch(scenario: {
  celoLogs: Array<{ topics: string[]; data: string; blockNumber: number; address: string }>;
  baseLogs: Array<{ topics: string[]; data: string; blockNumber: number; address: string }>;
  latestCeloBlock: number;
  latestBaseBlock: number;
  celoTimestamps?: Record<number, number>;
  baseTimestamps?: Record<number, number>;
}) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (body?.method === "eth_blockNumber") {
      const isCelo = url.includes("celo");
      return Response.json({ jsonrpc: "2.0", id: body.id, result: toHex(isCelo ? scenario.latestCeloBlock : scenario.latestBaseBlock) });
    }

    if (body?.method === "eth_getBlockByNumber") {
      const blockNumber = Number(body.params[0]);
      const isCelo = url.includes("celo");
      const timestamps = isCelo ? scenario.celoTimestamps : scenario.baseTimestamps;
      const ts = timestamps?.[blockNumber];
      return Response.json({ jsonrpc: "2.0", id: body.id, result: ts ? { timestamp: toHex(ts) } : null });
    }

    if (body?.method === "eth_getLogs") {
      const isCelo = url.includes("celo");
      return Response.json({ jsonrpc: "2.0", id: body.id, result: isCelo ? scenario.celoLogs : scenario.baseLogs });
    }

    if (body?.query) {
      return Response.json({ data: { streams: [{ currentFlowRate: "1000000000000000" }] } });
    }

    return new Response("not found", { status: 404 });
  };
}

function toHex(n: number): string {
  return `0x${n.toString(16)}`;
}
