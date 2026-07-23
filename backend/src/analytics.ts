import { Interface, getAddress } from "ethers";
import { RuntimeConfig } from "./env.js";
import { errorMessage, logError, logInfo, logWarn, redactAddress } from "./logging.js";

const CELO_VAULT_ANALYTICS_ABI = new Interface([
  "event GdDeposited(address indexed account,address indexed buyer,uint256 gdAmount,bytes data)",
  "event StreamUpdated(address indexed account,address indexed buyer,int96 flowRate,uint256 monthlyGdAmountWei,uint256 totalFlowWei)"
]);

const BASE_CHANNELS_CALLS_ABI = new Interface([
  "function reserve(address buyer, bytes32 salt, uint128 maxAmount, uint256 deadline, bytes buyerSig)",
  "function settle(bytes32 channelId, uint128 cumulativeAmount, bytes metadata, bytes buyerSig)",
  "function close(bytes32 channelId, uint128 finalAmount, bytes metadata, bytes buyerSig)",
  "function topUp(bytes32 channelId, uint128 cumulativeAmount, bytes metadata, bytes spendingSig, uint128 newMaxAmount, uint256 deadline, bytes reserveSig)",
  "function requestClose(bytes32 channelId)",
  "function withdraw(bytes32 channelId)"
]);

const ANALYTICS_DAILY_PREFIX = "analytics:daily:";
const ANALYTICS_GLOBAL_KEY = "analytics:global";
const ANALYTICS_LAST_RUN_KEY = "analytics:lastRun";
const ANALYTICS_PROCESSED_EVENT_PREFIX = "analytics:processed:";
const ANALYTICS_STREAM_TOTAL_PREFIX = "analytics:state:stream-total:";
const ANALYTICS_STREAM_FLOW_PREFIX = "analytics:state:stream-flow:";
const ANALYTICS_CHANNEL_SETTLED_PREFIX = "analytics:state:channel-settled:";

const DEFAULT_BASE_CHANNELS_ADDRESS = "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d";
const CELO_GD_DEPOSITED_EVENT = CELO_VAULT_ANALYTICS_ABI.getEvent("GdDeposited");
const CELO_STREAM_UPDATED_EVENT = CELO_VAULT_ANALYTICS_ABI.getEvent("StreamUpdated");

type KV = Pick<KVNamespace, "get" | "put">;

type RpcLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
};

type ParsedCeloAnalyticsEvent =
  | {
    kind: "deposit";
    account: string;
    gdAmountWei: bigint;
    blockNumber: bigint;
    txHash: string;
    logIndex: string;
  }
  | {
    kind: "stream";
    account: string;
    flowRateWeiPerSecond: bigint;
    totalFlowWei: bigint;
    blockNumber: bigint;
    txHash: string;
    logIndex: string;
  };

type ParsedBaseOperation = {
  kind: "reserve" | "settle" | "close" | "topUp" | "requestClose" | "withdraw";
  from: string;
  channelId?: string;
  cumulativeAmount?: bigint;
};

export type AnalyticsDaily = {
  date: string;
  gdOneTimeDeposits: string;
  gdStreamed: string;
  gdTotalFlowRate: string;
  aiCreditsUsed: string;
  uniqueGdBuyers: number;
  uniqueCreditUsers: number;
};

export type AnalyticsGlobal = {
  gdOneTimeDeposits: string;
  gdStreamed: string;
  gdTotalFlowRate: string;
  aiCreditsUsed: string;
  uniqueGdBuyers: number;
  uniqueCreditUsers: number;
};

export type AnalyticsLastRun = {
  celoLastBlock: string;
  baseLastBlock: string;
  refreshedAt: string;
};

export type AnalyticsResponse = {
  days: number;
  daily: AnalyticsDaily[];
  global: AnalyticsGlobal;
  lastRun: AnalyticsLastRun;
};

type RefreshSummary = {
  refreshed: boolean;
  celoProcessed: number;
  baseProcessed: number;
  reason?: string;
};

type DailyAccumulator = {
  date: string;
  gdOneTimeDeposits: bigint;
  gdStreamed: bigint;
  aiCreditsUsed: bigint;
  uniqueGdBuyers: Set<string>;
  uniqueCreditUsers: Set<string>;
};

export async function refreshAnalytics(env: EnvLike, cfg: RuntimeConfig, now = new Date()): Promise<RefreshSummary> {
  const kv = env.ANTSEED_KV;
  const existingLastRun = (await getJson<AnalyticsLastRun>(kv, ANALYTICS_LAST_RUN_KEY)) ?? {
    celoLastBlock: "0",
    baseLastBlock: "0",
    refreshedAt: new Date(0).toISOString()
  };

  const refreshIntervalSeconds = cfg.ANALYTICS_REFRESH_INTERVAL_SECONDS ?? 21_600;
  const lastRefreshedMs = Date.parse(existingLastRun.refreshedAt);
  if (!Number.isNaN(lastRefreshedMs) && now.getTime() - lastRefreshedMs < refreshIntervalSeconds * 1000) {
    return {
      refreshed: false,
      celoProcessed: 0,
      baseProcessed: 0,
      reason: "refresh_interval_not_elapsed"
    };
  }

  const globalTotals = (await getJson<AnalyticsGlobal>(kv, ANALYTICS_GLOBAL_KEY)) ?? emptyGlobal();
  const dailyMap = new Map<string, DailyAccumulator>();
  const globalUniqueGdBuyers = new Set<string>();
  const globalUniqueCreditUsers = new Set<string>();

  let celoProcessed = 0;
  let baseProcessed = 0;

  let celoLatestBlock = BigInt(existingLastRun.celoLastBlock || "0");
  if (cfg.CELO_RPC_URL) {
    celoLatestBlock = await rpcHexToBigInt(cfg.CELO_RPC_URL, "eth_blockNumber", []);
    const celoFromBlock = BigInt(existingLastRun.celoLastBlock || "0") + 1n;
    if (celoFromBlock <= celoLatestBlock && cfg.CELO_VAULT_ADDRESS) {
      if (!CELO_GD_DEPOSITED_EVENT || !CELO_STREAM_UPDATED_EVENT) {
        throw new Error("missing Celo vault analytics event ABI");
      }
      const celoLogs = await rpc<RpcLog[]>(cfg.CELO_RPC_URL, "eth_getLogs", [
        {
          address: cfg.CELO_VAULT_ADDRESS,
          fromBlock: toHex(celoFromBlock),
          toBlock: toHex(celoLatestBlock),
          topics: [[CELO_GD_DEPOSITED_EVENT.topicHash, CELO_STREAM_UPDATED_EVENT.topicHash]]
        }
      ]);
      const blockTimestampCache = new Map<string, number>();
      for (const log of celoLogs) {
        const processedKey = `${ANALYTICS_PROCESSED_EVENT_PREFIX}celo:${log.transactionHash}:${log.logIndex}`;
        if (await kv.get(processedKey)) continue;

        const event = parseCeloAnalyticsLog(log);
        if (!event) continue;

        const blockHex = toHex(event.blockNumber);
        const timestamp = await getBlockTimestamp(cfg.CELO_RPC_URL, blockHex, blockTimestampCache);
        const day = toUtcDay(timestamp);
        const daily = ensureDailyAccumulator(dailyMap, day);

        if (event.kind === "deposit") {
          daily.gdOneTimeDeposits += event.gdAmountWei;
          daily.uniqueGdBuyers.add(event.account);
          globalUniqueGdBuyers.add(event.account);
        } else {
          const streamTotalKey = `${ANALYTICS_STREAM_TOTAL_PREFIX}${event.account}`;
          const previousTotalRaw = await kv.get(streamTotalKey);
          const previousTotal = BigInt(previousTotalRaw ?? "0");
          const streamedDelta = event.totalFlowWei > previousTotal ? event.totalFlowWei - previousTotal : 0n;
          if (streamedDelta > 0n) {
            daily.gdStreamed += streamedDelta;
            daily.uniqueGdBuyers.add(event.account);
            globalUniqueGdBuyers.add(event.account);
          }
          await kv.put(streamTotalKey, event.totalFlowWei.toString());

          const streamFlowKey = `${ANALYTICS_STREAM_FLOW_PREFIX}${event.account}`;
          const previousFlowRaw = await kv.get(streamFlowKey);
          const previousFlow = BigInt(previousFlowRaw ?? "0");
          const currentGlobalFlow = BigInt(globalTotals.gdTotalFlowRate);
          const nextGlobalFlow = currentGlobalFlow + event.flowRateWeiPerSecond - previousFlow;
          globalTotals.gdTotalFlowRate = (nextGlobalFlow > 0n ? nextGlobalFlow : 0n).toString();
          await kv.put(streamFlowKey, event.flowRateWeiPerSecond.toString());
        }

        await kv.put(processedKey, "1");
        celoProcessed += 1;
      }
    }
  }

  let baseLatestBlock = BigInt(existingLastRun.baseLastBlock || "0");
  const baseRpcUrl = cfg.BASE_RPC_URL ?? cfg.ANTSEED_FUNDING_RPC_URL;
  const baseChannelsAddress = cfg.BASE_CHANNELS_ADDRESS ?? DEFAULT_BASE_CHANNELS_ADDRESS;
  if (baseRpcUrl && baseChannelsAddress) {
    baseLatestBlock = await rpcHexToBigInt(baseRpcUrl, "eth_blockNumber", []);
    const baseFromBlock = BigInt(existingLastRun.baseLastBlock || "0") + 1n;
    if (baseFromBlock <= baseLatestBlock) {
      const logs = await rpc<RpcLog[]>(baseRpcUrl, "eth_getLogs", [
        {
          address: baseChannelsAddress,
          fromBlock: toHex(baseFromBlock),
          toBlock: toHex(baseLatestBlock)
        }
      ]);
      const blockTimestampCache = new Map<string, number>();
      for (const log of logs) {
        const processedKey = `${ANALYTICS_PROCESSED_EVENT_PREFIX}base:${log.transactionHash}:${log.logIndex}`;
        if (await kv.get(processedKey)) continue;

        const tx = await rpc<{ input: string; from: string }>(baseRpcUrl, "eth_getTransactionByHash", [log.transactionHash]);
        if (!tx?.input || !tx.from) {
          await kv.put(processedKey, "1");
          continue;
        }
        const operation = parseBaseOperation(tx.input, tx.from);
        if (!operation) {
          await kv.put(processedKey, "1");
          continue;
        }

        const blockNumber = BigInt(log.blockNumber);
        const timestamp = await getBlockTimestamp(baseRpcUrl, toHex(blockNumber), blockTimestampCache);
        const day = toUtcDay(timestamp);
        const daily = ensureDailyAccumulator(dailyMap, day);

        daily.uniqueCreditUsers.add(operation.from);
        globalUniqueCreditUsers.add(operation.from);

        if ((operation.kind === "settle" || operation.kind === "close" || operation.kind === "topUp") && operation.channelId && operation.cumulativeAmount !== undefined) {
          const channelSettledKey = `${ANALYTICS_CHANNEL_SETTLED_PREFIX}${operation.channelId.toLowerCase()}`;
          const previousSettledRaw = await kv.get(channelSettledKey);
          const previousSettled = BigInt(previousSettledRaw ?? "0");
          const usedDelta = operation.cumulativeAmount > previousSettled ? operation.cumulativeAmount - previousSettled : 0n;
          if (usedDelta > 0n) {
            daily.aiCreditsUsed += usedDelta;
            await kv.put(channelSettledKey, operation.cumulativeAmount.toString());
          }
        }

        await kv.put(processedKey, "1");
        baseProcessed += 1;
      }
    }
  }

  for (const accumulator of dailyMap.values()) {
    const key = `${ANALYTICS_DAILY_PREFIX}${accumulator.date}`;
    const existing = (await getJson<AnalyticsDaily>(kv, key)) ?? emptyDaily(accumulator.date);
    const updated: AnalyticsDaily = {
      date: accumulator.date,
      gdOneTimeDeposits: (BigInt(existing.gdOneTimeDeposits) + accumulator.gdOneTimeDeposits).toString(),
      gdStreamed: (BigInt(existing.gdStreamed) + accumulator.gdStreamed).toString(),
      gdTotalFlowRate: globalTotals.gdTotalFlowRate,
      aiCreditsUsed: (BigInt(existing.aiCreditsUsed) + accumulator.aiCreditsUsed).toString(),
      uniqueGdBuyers: existing.uniqueGdBuyers + accumulator.uniqueGdBuyers.size,
      uniqueCreditUsers: existing.uniqueCreditUsers + accumulator.uniqueCreditUsers.size
    };
    await putJson(kv, key, updated);
  }

  globalTotals.gdOneTimeDeposits = (BigInt(globalTotals.gdOneTimeDeposits) + sumBigInt(dailyMap, (d) => d.gdOneTimeDeposits)).toString();
  globalTotals.gdStreamed = (BigInt(globalTotals.gdStreamed) + sumBigInt(dailyMap, (d) => d.gdStreamed)).toString();
  globalTotals.aiCreditsUsed = (BigInt(globalTotals.aiCreditsUsed) + sumBigInt(dailyMap, (d) => d.aiCreditsUsed)).toString();
  globalTotals.uniqueGdBuyers += globalUniqueGdBuyers.size;
  globalTotals.uniqueCreditUsers += globalUniqueCreditUsers.size;

  await putJson(kv, ANALYTICS_GLOBAL_KEY, globalTotals);
  await putJson(kv, ANALYTICS_LAST_RUN_KEY, {
    celoLastBlock: celoLatestBlock.toString(),
    baseLastBlock: baseLatestBlock.toString(),
    refreshedAt: now.toISOString()
  } satisfies AnalyticsLastRun);

  logInfo("analytics.refresh.summary", {
    refreshed: true,
    celoProcessed,
    baseProcessed,
    celoLatestBlock: celoLatestBlock.toString(),
    baseLatestBlock: baseLatestBlock.toString(),
    baseChannelsAddress: redactAddress(baseChannelsAddress)
  });

  return {
    refreshed: true,
    celoProcessed,
    baseProcessed
  };
}

export async function readAnalytics(kv: KV, days: number, now = new Date()): Promise<AnalyticsResponse> {
  const global = (await getJson<AnalyticsGlobal>(kv, ANALYTICS_GLOBAL_KEY)) ?? emptyGlobal();
  const lastRun = (await getJson<AnalyticsLastRun>(kv, ANALYTICS_LAST_RUN_KEY)) ?? {
    celoLastBlock: "0",
    baseLastBlock: "0",
    refreshedAt: new Date(0).toISOString()
  };

  const daily: AnalyticsDaily[] = [];
  for (const date of getDateWindow(days, now)) {
    const saved = await getJson<AnalyticsDaily>(kv, `${ANALYTICS_DAILY_PREFIX}${date}`);
    daily.push(saved ?? {
      ...emptyDaily(date),
      gdTotalFlowRate: global.gdTotalFlowRate
    });
  }

  return {
    days,
    daily,
    global,
    lastRun
  };
}

function ensureDailyAccumulator(map: Map<string, DailyAccumulator>, day: string): DailyAccumulator {
  const existing = map.get(day);
  if (existing) return existing;
  const created: DailyAccumulator = {
    date: day,
    gdOneTimeDeposits: 0n,
    gdStreamed: 0n,
    aiCreditsUsed: 0n,
    uniqueGdBuyers: new Set(),
    uniqueCreditUsers: new Set()
  };
  map.set(day, created);
  return created;
}

function emptyDaily(date: string): AnalyticsDaily {
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

function emptyGlobal(): AnalyticsGlobal {
  return {
    gdOneTimeDeposits: "0",
    gdStreamed: "0",
    gdTotalFlowRate: "0",
    aiCreditsUsed: "0",
    uniqueGdBuyers: 0,
    uniqueCreditUsers: 0
  };
}

function sumBigInt(map: Map<string, DailyAccumulator>, getter: (daily: DailyAccumulator) => bigint): bigint {
  let total = 0n;
  for (const daily of map.values()) total += getter(daily);
  return total;
}

function parseCeloAnalyticsLog(log: RpcLog): ParsedCeloAnalyticsEvent | undefined {
  try {
    const parsed = CELO_VAULT_ANALYTICS_ABI.parseLog(log);
    if (!parsed) return undefined;
    if (parsed.name === "GdDeposited") {
      return {
        kind: "deposit",
        account: getAddress(String(parsed.args.account)).toLowerCase(),
        gdAmountWei: BigInt(parsed.args.gdAmount.toString()),
        blockNumber: BigInt(log.blockNumber),
        txHash: log.transactionHash,
        logIndex: log.logIndex
      };
    }
    if (parsed.name === "StreamUpdated") {
      return {
        kind: "stream",
        account: getAddress(String(parsed.args.account)).toLowerCase(),
        flowRateWeiPerSecond: BigInt(parsed.args.flowRate.toString()),
        totalFlowWei: BigInt(parsed.args.totalFlowWei.toString()),
        blockNumber: BigInt(log.blockNumber),
        txHash: log.transactionHash,
        logIndex: log.logIndex
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseBaseOperation(input: string, from: string): ParsedBaseOperation | undefined {
  try {
    const tx = BASE_CHANNELS_CALLS_ABI.parseTransaction({ data: input });
    if (!tx) return undefined;
    const sender = getAddress(from).toLowerCase();
    switch (tx.name) {
      case "reserve":
        return { kind: "reserve", from: sender };
      case "settle":
        return {
          kind: "settle",
          from: sender,
          channelId: String(tx.args[0]),
          cumulativeAmount: BigInt(tx.args[1].toString())
        };
      case "close":
        return {
          kind: "close",
          from: sender,
          channelId: String(tx.args[0]),
          cumulativeAmount: BigInt(tx.args[1].toString())
        };
      case "topUp":
        return {
          kind: "topUp",
          from: sender,
          channelId: String(tx.args[0]),
          cumulativeAmount: BigInt(tx.args[1].toString())
        };
      case "requestClose":
        return {
          kind: "requestClose",
          from: sender,
          channelId: String(tx.args[0])
        };
      case "withdraw":
        return {
          kind: "withdraw",
          from: sender,
          channelId: String(tx.args[0])
        };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

async function getBlockTimestamp(rpcUrl: string, blockHex: string, cache: Map<string, number>): Promise<number> {
  const cached = cache.get(blockHex);
  if (cached !== undefined) return cached;
  const block = await rpc<{ timestamp: string }>(rpcUrl, "eth_getBlockByNumber", [blockHex, false]);
  const timestamp = Number(BigInt(block.timestamp));
  cache.set(blockHex, timestamp);
  return timestamp;
}

function getDateWindow(days: number, now: Date): string[] {
  const dates: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - offset);
    dates.push(toUtcDay(Math.floor(date.getTime() / 1000)));
  }
  return dates;
}

function toUtcDay(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
}

function toHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

async function rpcHexToBigInt(url: string, method: string, params: unknown[]): Promise<bigint> {
  const value = await rpc<string>(url, method, params);
  return BigInt(value);
}

async function rpc<T>(url: string, method: string, params: unknown[], retries = 3): Promise<T> {
  let attempt = 0;
  while (attempt < retries) {
    attempt += 1;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const body = (await response.json()) as { result?: T; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message ?? "RPC error");
      return body.result as T;
    } catch (error) {
      const message = errorMessage(error);
      if (attempt >= retries) {
        logError("analytics.rpc.failed", {
          method,
          url,
          attempt,
          message
        });
        throw error;
      }
      logWarn("analytics.rpc.retry", {
        method,
        url,
        attempt,
        message
      });
    }
  }
  throw new Error("unreachable");
}

async function getJson<T>(kv: KV, key: string): Promise<T | undefined> {
  const value = await kv.get(key, "json");
  return (value ?? undefined) as T | undefined;
}

async function putJson(kv: KV, key: string, value: unknown): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}

type EnvLike = {
  ANTSEED_KV: KVNamespace;
};
