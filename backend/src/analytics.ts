import { Interface } from "ethers";
import { Env } from "./env.js";
import { errorMessage, logError, logInfo, logWarn, redactAddress } from "./logging.js";

type KV = Pick<KVNamespace, "get" | "put">;

type ExplorerLog = {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: string;
  blockNumber: string;
  timeStamp: string;
};

type StreamSnapshot = {
  sender: string;
  flowRateWeiPerSecond: bigint;
  totalStreamedWei: bigint;
};

type AnalyticsState = {
  finalizedThroughDate?: string;
  updatedAt: string;
};

export type AnalyticsDailyRecord = {
  date: string;
  gdOneTimeDepositsWei: string;
  gdStreamedWei: string;
  gdTotalFlowRateWeiPerSecond: string;
  aiCreditsUsedWei: string;
  uniqueGdBuyers: number;
  uniqueCreditUsers: number;
  updatedAt: string;
};

export type AnalyticsGlobalTotals = {
  gdOneTimeDepositsWei: string;
  gdStreamedWei: string;
  aiCreditsUsedWei: string;
  gdTotalFlowRateWeiPerSecond: string;
  updatedAt: string;
};

export type AnalyticsLastRun = {
  currentDate: string;
  finalizedThroughDate?: string;
  updatedAt: string;
};

export type AnalyticsResponse = {
  days: number;
  daily: AnalyticsDailyRecord[];
  global: AnalyticsGlobalTotals;
  lastRun: AnalyticsLastRun;
};

export type AnalyticsRunSummary = {
  ok: true;
  currentDate: string;
  finalizedDates: string[];
  celo: { fromTimestamp: number; toTimestamp: number; scanned: number; matched: number };
  base: { fromTimestamp: number; toTimestamp: number; scanned: number; matched: number };
  streams: { senders: number; totalFlowRateWeiPerSecond: string };
};

type DailyAggregate = {
  gdOneTimeDepositsWei: bigint;
  gdStreamedWei: bigint;
  gdTotalFlowRateWeiPerSecond: bigint;
  aiCreditsUsedWei: bigint;
  gdBuyers: Set<string>;
  creditUsers: Set<string>;
};

type AnalyticsConfig = {
  celoBlockscoutUrl: string;
  baseBlockscoutUrl: string;
  celoVaultAddress?: string;
  baseChannelsAddress: string;
  celoSuperTokenAddress?: string;
  celoStreamReceiverAddress?: string;
  superfluidSubgraphUrl: string;
};

const CELO_VAULT_EVENTS = new Interface(["event GdDeposited(address indexed account,address indexed buyer,uint256 gdAmount,bytes data)"]);

const BASE_CHANNEL_EVENTS = new Interface([
  "event Reserved(bytes32 indexed channelId,address indexed buyer,address indexed seller,uint128 maxAmount)",
  "event ChannelSettled(bytes32 indexed channelId,address indexed buyer,address indexed seller,uint128 cumulativeAmount,uint128 delta,uint128 totalSettled,uint256 platformFee,bytes metadata)",
  "event ChannelClosed(bytes32 indexed channelId,address indexed buyer,address indexed seller,uint128 settledAmount,uint128 refund)",
  "event ChannelTopUp(bytes32 indexed channelId,address indexed buyer,address indexed seller,uint128 additionalAmount,uint128 newDeposit)",
  "event ChannelWithdrawn(bytes32 indexed channelId,address indexed buyer,address indexed seller,uint128 refund)",
  "event CloseRequested(bytes32 indexed channelId,address indexed buyer,address indexed seller,uint256 gracePeriodEnd)"
]);

const DAILY_PREFIX = "analytics:daily:";
const GLOBAL_KEY = "analytics:global";
const STATE_KEY = "analytics:state";
const BUYER_REGISTRY_KEY = "analytics:buyers:registry";
const GD_BUYERS_PREFIX = "analytics:buyers:gd:";
const CREDIT_USERS_PREFIX = "analytics:buyers:credits:";
const EXPLORER_LOG_BATCH_LIMIT = 1000;

const ZERO_DAILY = {
  gdOneTimeDepositsWei: "0",
  gdStreamedWei: "0",
  gdTotalFlowRateWeiPerSecond: "0",
  aiCreditsUsedWei: "0",
  uniqueGdBuyers: 0,
  uniqueCreditUsers: 0
};

export async function runAnalyticsAggregation(env: Env, now = new Date()): Promise<AnalyticsRunSummary> {
  const cfg = analyticsConfigFromEnv(env);
  const store = new KVAnalyticsStore(env.ANTSEED_KV);
  const currentDate = dayFromDate(now);
  const state = (await store.getState()) ?? {
    updatedAt: now.toISOString()
  };

  const finalizedDates = await finalizeClosedDays(store, state, currentDate, now);
  const dayWindow = getUtcDayWindow(now);
  const aggregate = createDailyAggregate();
  const knownBuyers = await store.getBuyerRegistry();
  const discoveredBuyers = new Set<string>();

  const celoMetrics = await collectCeloDayMetrics(cfg, dayWindow, aggregate, discoveredBuyers);
  logInfo("got celo metrics");
  if (discoveredBuyers.size > 0) {
    await store.addBuyersToRegistry([...discoveredBuyers]);
    for (const buyer of discoveredBuyers) knownBuyers.add(buyer);
  }
  logInfo("getting base metrics....");
  const baseMetrics = await collectBaseDayMetrics(cfg, dayWindow, aggregate, knownBuyers);
  logInfo("got base metrics....");

  const streamMetrics = await collectStreamDayMetrics(cfg, dayWindow, aggregate, now);
  logInfo("building dialy reocrd....");

  const dailyRecord = buildDailyRecord(currentDate, aggregate, now);
  await store.replaceDaily(currentDate, dailyRecord, [...aggregate.gdBuyers], [...aggregate.creditUsers]);
  const latestState = await store.getState();
  await store.putState({
    finalizedThroughDate: latestState?.finalizedThroughDate,
    updatedAt: now.toISOString()
  });

  logInfo("analytics.sync.end", {
    currentDate,
    finalizedDates,
    aggregate,
    celoMetrics,
    baseMetrics,
    streamMetrics
  });

  return {
    ok: true,
    currentDate,
    finalizedDates,
    celo: celoMetrics,
    base: baseMetrics,
    streams: streamMetrics
  };
}

export async function getAnalyticsWindow(env: Env, days = 30, now = new Date()): Promise<AnalyticsResponse> {
  const normalizedDays = Math.max(1, Math.min(days, 365));
  const store = new KVAnalyticsStore(env.ANTSEED_KV);
  const currentDate = dayFromDate(now);

  const daily: AnalyticsDailyRecord[] = [];
  for (let i = normalizedDays - 1; i >= 0; i -= 1) {
    const date = dayFromDate(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
    daily.push(await store.getDaily(date));
  }

  const persistedGlobal = await store.getGlobal();
  const today = await store.getDaily(currentDate);
  const global = addDailyToGlobal(persistedGlobal, today, now.toISOString());
  const state = (await store.getState()) ?? { updatedAt: now.toISOString() };

  return {
    days: normalizedDays,
    daily,
    global,
    lastRun: {
      currentDate,
      finalizedThroughDate: state.finalizedThroughDate,
      updatedAt: state.updatedAt
    }
  };
}

export class KVAnalyticsStore {
  constructor(private readonly kv: KV) {}

  async getBuyerRegistry(): Promise<Set<string>> {
    const buyers = (await this.getJson<string[]>(BUYER_REGISTRY_KEY)) ?? [];
    return new Set(buyers.map((buyer) => buyer.toLowerCase()));
  }

  async addBuyersToRegistry(buyers: string[]): Promise<void> {
    if (buyers.length === 0) return;
    const existing = await this.getBuyerRegistry();
    for (const buyer of buyers) {
      existing.add(buyer.toLowerCase());
    }
    await this.putJson(BUYER_REGISTRY_KEY, [...existing].sort());
  }

  async getDaily(date: string): Promise<AnalyticsDailyRecord> {
    const key = `${DAILY_PREFIX}${date}`;
    const value = await this.getJson<AnalyticsDailyRecord>(key);
    if (value) return value;
    return {
      date,
      ...ZERO_DAILY,
      updatedAt: new Date().toISOString()
    };
  }

  async replaceDaily(date: string, value: AnalyticsDailyRecord, gdBuyers: string[], creditUsers: string[]): Promise<void> {
    await this.putJson(`${DAILY_PREFIX}${date}`, value);
    await this.putJson(`${GD_BUYERS_PREFIX}${date}`, dedupeAccounts(gdBuyers));
    await this.putJson(`${CREDIT_USERS_PREFIX}${date}`, dedupeAccounts(creditUsers));
  }

  async getGlobal(): Promise<AnalyticsGlobalTotals> {
    const value = await this.getJson<AnalyticsGlobalTotals>(GLOBAL_KEY);
    if (value) return value;
    return {
      gdOneTimeDepositsWei: "0",
      gdStreamedWei: "0",
      aiCreditsUsedWei: "0",
      gdTotalFlowRateWeiPerSecond: "0",
      updatedAt: new Date().toISOString()
    };
  }

  async putGlobal(value: AnalyticsGlobalTotals): Promise<void> {
    await this.putJson(GLOBAL_KEY, value);
  }

  async getState(): Promise<AnalyticsState | undefined> {
    return this.getJson<AnalyticsState>(STATE_KEY);
  }

  async putState(value: AnalyticsState): Promise<void> {
    await this.putJson(STATE_KEY, value);
  }

  private async getJson<T>(key: string): Promise<T | undefined> {
    const value = await this.kv.get(key, "json");
    return (value ?? undefined) as T | undefined;
  }

  private async putJson(key: string, value: unknown): Promise<void> {
    await this.kv.put(key, JSON.stringify(value));
  }
}

function analyticsConfigFromEnv(env: Env): AnalyticsConfig {
  return {
    celoBlockscoutUrl: env.CELO_BLOCKSCOUT_API_URL ?? "https://celo.blockscout.com/api",
    baseBlockscoutUrl: env.BASE_BLOCKSCOUT_API_URL ?? "https://base.blockscout.com/api",
    celoVaultAddress: env.CELO_VAULT_ADDRESS,
    baseChannelsAddress: (env.ANTSEED_CHANNELS_ADDRESS ?? "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d").toLowerCase(),
    celoSuperTokenAddress: env.CELO_GD_SUPERTOKEN_ADDRESS?.toLowerCase(),
    celoStreamReceiverAddress: env.CELO_VAULT_ADDRESS?.toLowerCase(),
    superfluidSubgraphUrl: env.SUPERFLUID_SUBGRAPH_URL ?? "https://celo-mainnet.subgraph.x.superfluid.dev/"
  };
}

async function finalizeClosedDays(store: KVAnalyticsStore, state: AnalyticsState, currentDate: string, now: Date): Promise<string[]> {
  const finalizedDates: string[] = [];
  const yesterday = previousDate(currentDate);
  if (!yesterday) return finalizedDates;

  const startDate = state.finalizedThroughDate ? nextDate(state.finalizedThroughDate) : yesterday;
  if (!startDate) {
    return finalizedDates;
  }

  if (startDate > yesterday) {
    return finalizedDates;
  }

  let global = await store.getGlobal();
  let cursor = startDate;
  while (cursor <= yesterday) {
    const day = await store.getDaily(cursor);
    global = addDailyToGlobal(global, day, now.toISOString());
    finalizedDates.push(cursor);
    const next = nextDate(cursor);
    if (!next) break;
    cursor = next;
  }

  await store.putGlobal(global);
  await store.putState({
    finalizedThroughDate: finalizedDates[finalizedDates.length - 1],
    updatedAt: now.toISOString()
  });
  return finalizedDates;
}

async function collectCeloDayMetrics(
  cfg: AnalyticsConfig,
  dayWindow: UtcDayWindow,
  aggregate: DailyAggregate,
  discoveredBuyers: Set<string>
): Promise<{ fromTimestamp: number; toTimestamp: number; scanned: number; matched: number }> {
  if (!cfg.celoVaultAddress) {
    return {
      fromTimestamp: dayWindow.startUnix,
      toTimestamp: dayWindow.endUnix,
      scanned: 0,
      matched: 0
    };
  }

  const range = await getExplorerBlockRange(cfg.celoBlockscoutUrl, dayWindow);

  const logs = await getExplorerEvents(cfg.celoBlockscoutUrl, {
    address: cfg.celoVaultAddress,
    topic0: getTopicHash(CELO_VAULT_EVENTS, "GdDeposited"),
    fromBlock: range.fromBlock,
    toBlock: range.toBlock
  });
  logInfo("analytics.celo.scan", {
    range,
    dayWindow,
    foundLogs: logs.length
  });
  let matched = 0;
  for (const log of logs) {
    const decoded = decodeEventSafe(CELO_VAULT_EVENTS, log);
    if (!decoded || decoded.name !== "GdDeposited") continue;
    matched += 1;
    aggregate.gdOneTimeDepositsWei += BigInt(decoded.args.gdAmount.toString());
    aggregate.gdBuyers.add(String(decoded.args.account).toLowerCase());
    discoveredBuyers.add(String(decoded.args.buyer).toLowerCase());
  }

  return {
    fromTimestamp: dayWindow.startUnix,
    toTimestamp: dayWindow.endUnix,
    scanned: logs.length,
    matched
  };
}

async function collectBaseDayMetrics(
  cfg: AnalyticsConfig,
  dayWindow: UtcDayWindow,
  aggregate: DailyAggregate,
  knownBuyers: Set<string>
): Promise<{ fromTimestamp: number; toTimestamp: number; scanned: number; matched: number }> {
  const eventNames = ["Reserved", "ChannelSettled", "ChannelClosed", "ChannelTopUp", "ChannelWithdrawn", "CloseRequested"] as const;

  let scanned = 0;
  let matched = 0;
  const range = await getExplorerBlockRange(cfg.baseBlockscoutUrl, dayWindow);
  logInfo("base range:", range);
  for (const eventName of eventNames) {
    const logs = await getExplorerEvents(cfg.baseBlockscoutUrl, {
      address: cfg.baseChannelsAddress,
      topic0: getTopicHash(BASE_CHANNEL_EVENTS, eventName),
      fromBlock: range.fromBlock,
      toBlock: range.toBlock
    });
    logInfo("analytics.base.scan", {
      eventName,
      range,
      dayWindow,
      foundLogs: logs.length
    });
    scanned += logs.length;

    for (const log of logs) {
      const decoded = decodeEventSafe(BASE_CHANNEL_EVENTS, log);
      if (!decoded) continue;
      const buyer = String(decoded.args.buyer).toLowerCase();
      if (!knownBuyers.has(buyer)) continue;
      matched += 1;
      aggregate.creditUsers.add(buyer);
      if (decoded.name === "ChannelSettled") {
        aggregate.aiCreditsUsedWei += BigInt(decoded.args.delta.toString());
      }
    }
  }

  return {
    fromTimestamp: dayWindow.startUnix,
    toTimestamp: dayWindow.endUnix,
    scanned,
    matched
  };
}

async function collectStreamDayMetrics(
  cfg: AnalyticsConfig,
  dayWindow: UtcDayWindow,
  aggregate: DailyAggregate,
  now: Date
): Promise<{ senders: number; totalFlowRateWeiPerSecond: string }> {
  const snapshots = await fetchStreamSnapshots(cfg, now, dayWindow.startUnix);

  for (const snapshot of snapshots) {
    aggregate.gdTotalFlowRateWeiPerSecond += snapshot.flowRateWeiPerSecond;
    if (snapshot.totalStreamedWei > 0n) {
      aggregate.gdStreamedWei += snapshot.totalStreamedWei;
      aggregate.gdBuyers.add(snapshot.sender);
    }
  }

  return {
    senders: snapshots.length,
    totalFlowRateWeiPerSecond: aggregate.gdTotalFlowRateWeiPerSecond.toString()
  };
}

function buildDailyRecord(date: string, aggregate: DailyAggregate, now: Date): AnalyticsDailyRecord {
  return {
    date,
    gdOneTimeDepositsWei: aggregate.gdOneTimeDepositsWei.toString(),
    gdStreamedWei: aggregate.gdStreamedWei.toString(),
    gdTotalFlowRateWeiPerSecond: aggregate.gdTotalFlowRateWeiPerSecond.toString(),
    aiCreditsUsedWei: aggregate.aiCreditsUsedWei.toString(),
    uniqueGdBuyers: aggregate.gdBuyers.size,
    uniqueCreditUsers: aggregate.creditUsers.size,
    updatedAt: now.toISOString()
  };
}

function addDailyToGlobal(global: AnalyticsGlobalTotals, day: AnalyticsDailyRecord, updatedAt: string): AnalyticsGlobalTotals {
  return {
    gdOneTimeDepositsWei: (BigInt(global.gdOneTimeDepositsWei) + BigInt(day.gdOneTimeDepositsWei)).toString(),
    gdStreamedWei: (BigInt(global.gdStreamedWei) + BigInt(day.gdStreamedWei)).toString(),
    aiCreditsUsedWei: (BigInt(global.aiCreditsUsedWei) + BigInt(day.aiCreditsUsedWei)).toString(),
    gdTotalFlowRateWeiPerSecond: BigInt(day.gdTotalFlowRateWeiPerSecond).toString(),
    updatedAt
  };
}

async function fetchStreamSnapshots(cfg: AnalyticsConfig, now: Date, dayStartUnix: number): Promise<StreamSnapshot[]> {
  if (!cfg.celoSuperTokenAddress || !cfg.celoStreamReceiverAddress) {
    logWarn("analytics.streams.skipped", {
      reason: "missing_config",
      hasToken: Boolean(cfg.celoSuperTokenAddress),
      hasReceiver: Boolean(cfg.celoStreamReceiverAddress)
    });
    return [];
  }

  const snapshotsBySender = new Map<string, { flowRateWeiPerSecond: bigint; totalStreamedWei: bigint }>();
  const pageSize = 1000;
  let skip = 0;
  const nowUnix = Math.floor(now.getTime() / 1000);

  while (true) {
    const body = {
      query: `
        query StreamsPage($receiver: String!, $token: String!, $first: Int!, $skip: Int!) {
          streams(
            where: { receiver: $receiver, token: $token }
            first: $first
            skip: $skip
          ) {
            sender { id }
            currentFlowRate
            streamedUntilUpdatedAt
            updatedAtTimestamp
          }
        }
      `,
      variables: {
        receiver: cfg.celoStreamReceiverAddress,
        token: cfg.celoSuperTokenAddress,
        first: pageSize,
        skip
      }
    };

    const response = await retry(
      () =>
        fetch(cfg.superfluidSubgraphUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }),
      3,
      500
    );

    if (!response.ok) {
      throw new Error(`Superfluid subgraph HTTP ${response.status}`);
    }

    const json = (await response.json()) as {
      data?: {
        streams?: Array<{
          sender: { id: string };
          currentFlowRate: string;
          streamedUntilUpdatedAt: string;
          updatedAtTimestamp: string;
        }>;
      };
    };

    const batch = json.data?.streams ?? [];
    for (const stream of batch) {
      const sender = stream.sender.id.toLowerCase();
      const currentFlowRate = BigInt(stream.currentFlowRate || "0");
      const streamedUntilUpdatedAt = BigInt(stream.streamedUntilUpdatedAt || "0");
      const updatedAtTimestamp = parseNumberish(stream.updatedAtTimestamp || "0");
      const totalStreamedWei = streamedWithinDay(streamedUntilUpdatedAt, currentFlowRate, updatedAtTimestamp, dayStartUnix, nowUnix);
      const existing = snapshotsBySender.get(sender);
      if (existing) {
        existing.flowRateWeiPerSecond += currentFlowRate;
        existing.totalStreamedWei += totalStreamedWei;
      } else {
        snapshotsBySender.set(sender, {
          flowRateWeiPerSecond: currentFlowRate,
          totalStreamedWei
        });
      }
    }

    if (batch.length < pageSize) break;
    skip += pageSize;
  }

  return [...snapshotsBySender.entries()].map(([sender, value]) => ({
    sender,
    flowRateWeiPerSecond: value.flowRateWeiPerSecond,
    totalStreamedWei: value.totalStreamedWei
  }));
}

async function getExplorerEvents(
  apiUrl: string,
  params: {
    address: string;
    topic0: string;
    fromBlock: number;
    toBlock: number;
  }
): Promise<ExplorerLog[]> {
  return getExplorerEventsByRange(apiUrl, params, params.fromBlock, params.toBlock);
}

async function getExplorerEventsByRange(
  apiUrl: string,
  params: {
    address: string;
    topic0: string;
    fromBlock: number;
    toBlock: number;
  },
  fromBlock: number,
  toBlock: number
): Promise<ExplorerLog[]> {
  const batch = await fetchExplorerLogBatch(apiUrl, {
    address: params.address,
    topic0: params.topic0,
    fromBlock,
    toBlock
  });

  if (batch.length < EXPLORER_LOG_BATCH_LIMIT) {
    return batch;
  }

  if (fromBlock >= toBlock) {
    logWarn("analytics.explorer.truncated", {
      apiUrl,
      address: redactAddress(params.address),
      topic0: params.topic0,
      fromBlock,
      toBlock,
      returned: batch.length
    });
    return dedupeExplorerLogs(batch);
  }

  const midpoint = fromBlock + Math.floor((toBlock - fromBlock) / 2);
  const left = await getExplorerEventsByRange(apiUrl, params, fromBlock, midpoint);
  const right = await getExplorerEventsByRange(apiUrl, params, midpoint + 1, toBlock);
  return dedupeExplorerLogs([...left, ...right]);
}

async function fetchExplorerLogBatch(
  apiUrl: string,
  params: {
    address: string;
    topic0: string;
    fromBlock: number;
    toBlock: number;
  }
): Promise<ExplorerLog[]> {
  const all: ExplorerLog[] = [];
  const url = new URL(apiUrl);
  url.searchParams.set("module", "logs");
  url.searchParams.set("action", "getLogs");
  url.searchParams.set("address", params.address);
  url.searchParams.set("topic0", params.topic0);
  url.searchParams.set("sort", "asc");
  url.searchParams.set("offset", String(EXPLORER_LOG_BATCH_LIMIT));
  url.searchParams.set("fromBlock", String(params.fromBlock));
  url.searchParams.set("toBlock", String(params.toBlock));

  const response = await retry(() => fetch(url), 3, 300);
  if (!response.ok) {
    throw new Error(`Explorer HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    status?: string;
    message?: string;
    result?: ExplorerLog[] | string;
  };
  if (Array.isArray(payload.result)) {
    all.push(...payload.result);
    return all;
  }

  if (typeof payload.result === "string" && payload.result.toLowerCase().includes("no records")) {
    return all;
  }

  if (payload.status === "0" && payload.message?.toLowerCase().includes("no records")) {
    return all;
  }

  logWarn("analytics.explorer.unexpected", {
    apiUrl,
    address: redactAddress(params.address),
    topic0: params.topic0,
    fromBlock: params.fromBlock,
    toBlock: params.toBlock,
    payload
  });
  return all;
}

async function getExplorerBlockRange(apiUrl: string, dayWindow: UtcDayWindow): Promise<{ fromBlock: number; toBlock: number }> {
  const fromBlock = await getBlockByTimestamp(apiUrl, dayWindow.startUnix, "after");
  const toBlock = await getBlockByTimestamp(apiUrl, dayWindow.endUnix, "before");
  return {
    fromBlock,
    toBlock: toBlock >= fromBlock ? toBlock : fromBlock
  };
}

async function getBlockByTimestamp(apiUrl: string, timestamp: number, closest: "before" | "after"): Promise<number> {
  const url = new URL(apiUrl);
  url.searchParams.set("module", "block");
  url.searchParams.set("action", "getblocknobytime");
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("closest", closest);

  const response = await retry(() => fetch(url), 3, 300);
  if (!response.ok) {
    throw new Error(`Explorer HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    status?: string;
    message?: string;
    result: { blockNumber: string };
  };

  if (payload.result && payload.status !== "0") {
    return parseNumberish(payload.result?.blockNumber ?? payload.result);
  }

  throw new Error(`Explorer getblocknobytime failed: ${payload.message ?? "unknown"}`);
}

function createDailyAggregate(): DailyAggregate {
  return {
    gdOneTimeDepositsWei: 0n,
    gdStreamedWei: 0n,
    gdTotalFlowRateWeiPerSecond: 0n,
    aiCreditsUsedWei: 0n,
    gdBuyers: new Set<string>(),
    creditUsers: new Set<string>()
  };
}

type UtcDayWindow = {
  startUnix: number;
  endUnix: number;
};

function getUtcDayWindow(date: Date, mode: "full-day" | "until-now" = "full-day"): UtcDayWindow {
  const startMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0);
  const endMs = mode === "full-day" ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999) : date.getTime();

  return {
    startUnix: Math.floor(startMs / 1000),
    endUnix: Math.floor(endMs / 1000)
  };
}

function dayFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function previousDate(date: string): string | undefined {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return dayFromDate(parsed);
}

function nextDate(date: string): string | undefined {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return dayFromDate(parsed);
}

function dedupeAccounts(accounts: string[]): string[] {
  return [...new Set(accounts.map((account) => account.toLowerCase()))].sort();
}

function streamedWithinDay(streamedUntilUpdatedAt: bigint, currentFlowRate: bigint, updatedAtTimestamp: number, dayStartUnix: number, nowUnix: number): bigint {
  if (updatedAtTimestamp >= dayStartUnix) {
    const boundedActiveSeconds = BigInt(Math.max(0, nowUnix - updatedAtTimestamp));
    return streamedUntilUpdatedAt + currentFlowRate * boundedActiveSeconds;
  }
  if (currentFlowRate === 0n) {
    return 0n;
  }
  const boundedUpdatedAt = Math.max(updatedAtTimestamp, dayStartUnix);
  const activeSeconds = BigInt(Math.max(0, nowUnix - boundedUpdatedAt));
  return currentFlowRate * activeSeconds;
}

function getTopicHash(iface: Interface, eventName: string): string {
  const event = iface.getEvent(eventName);
  if (!event) throw new Error(`event not found: ${eventName}`);
  return event.topicHash;
}

function decodeEventSafe(iface: Interface, log: ExplorerLog) {
  try {
    log.topics = log.topics.filter((topic) => topic);
    return iface.parseLog(log);
  } catch (error) {
    logWarn("analytics.decode.failed", {
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      message: errorMessage(error)
    });
    return null;
  }
}

function parseNumberish(value: string | number): number {
  if (typeof value === "number") return value;
  if (value.startsWith("0x")) return Number.parseInt(value, 16);
  return Number.parseInt(value, 10);
}

function dedupeExplorerLogs(logs: ExplorerLog[]): ExplorerLog[] {
  const seen = new Set<string>();
  const deduped: ExplorerLog[] = [];

  for (const log of logs) {
    const key = `${log.transactionHash}:${log.logIndex}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(log);
  }

  return deduped;
}

async function retry<T>(fn: () => Promise<T>, retries: number, waitMs: number): Promise<T> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt > retries) break;
      await wait(waitMs);
    }
  }
  logError("analytics.retry.failed", {
    retries,
    message: errorMessage(lastError)
  });
  throw lastError instanceof Error ? lastError : new Error("retry failed");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
