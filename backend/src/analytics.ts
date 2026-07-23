import { getAddress, Interface } from "ethers";
import { RuntimeConfig } from "./env.js";
import { errorMessage, logError, logInfo, logWarn } from "./logging.js";

const ANTSEED_CHANNELS_ABI = new Interface([
  "event Reserved(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 deposit, bytes32 metadataHash, uint256 deadline)",
  "event ChannelSettled(bytes32 indexed channelId, address indexed buyer, uint256 settledAmount)",
  "event ChannelClosed(bytes32 indexed channelId, address indexed buyer, uint256 settledAmount)",
  "event ChannelTopUp(bytes32 indexed channelId, address indexed buyer, uint256 amount)",
  "event ChannelWithdrawn(bytes32 indexed channelId, address indexed buyer, uint256 amount)",
  "event CloseRequested(bytes32 indexed channelId, address indexed buyer, uint256 timestamp)"
]);

const VAULT_EVENTS = new Interface([
  "event GdDeposited(address indexed account,address indexed buyer,uint256 gdAmount,bytes data)",
  "event StreamUpdated(address indexed account,address indexed buyer,int96 flowRate,uint256 monthlyGdAmountWei,uint256 totalFlowWei)"
]);

const LAST_RUN_KEY = "analytics:lastRun";
const DAILY_PREFIX = "analytics:daily:";
const GLOBAL_KEY = "analytics:global";

export type DailyAnalytics = {
  date: string;
  gdOneTimeDeposits: string;
  gdStreamed: string;
  gdTotalFlowRate: string;
  aiCreditsUsed: string;
  uniqueGdBuyers: number;
  uniqueCreditUsers: number;
};

export type GlobalAnalytics = {
  gdOneTimeDeposits: string;
  gdStreamed: string;
  gdTotalFlowRate: string;
  aiCreditsUsed: string;
  uniqueGdBuyers: number;
  uniqueCreditUsers: number;
};

export type AnalyticsResponse = {
  days: DailyAnalytics[];
  global: GlobalAnalytics;
};

type AnalyticsLastRun = {
  celoBlock: number;
  baseBlock: number;
  timestamp: string;
};

type KV = Pick<KVNamespace, "get" | "put">;

export type AnalyticsClientDependencies = {
  kv: KV;
  cfg: RuntimeConfig;
  fetch?: typeof fetch;
};

export class AnalyticsClient {
  private readonly kv: KV;
  private readonly cfg: RuntimeConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: AnalyticsClientDependencies) {
    this.kv = deps.kv;
    this.cfg = deps.cfg;
    this.fetchImpl = deps.fetch ?? fetch;
  }

  /**
   * Run an incremental analytics aggregation pass.
   * Fetches new Celo vault logs, Base channel logs, and current Superfluid flow rates,
   * groups them by UTC day, and updates daily + global KV records.
   */
  async runAggregation(): Promise<void> {
    const startedAt = Date.now();
    logInfo("analytics.run.start");

    const lastRun = await this.getLastRun();
    const latestCeloBlock = await this.getLatestBlockNumber(this.cfg.CELO_RPC_URL);

    const celoFrom = lastRun ? lastRun.celoBlock + 1 : 0;
    const baseFrom = lastRun ? lastRun.baseBlock + 1 : 0;

    const [celoEvents, baseResult, totalFlowRate, latestBaseBlock] = await Promise.all([
      this.fetchCeloVaultLogs(celoFrom, latestCeloBlock),
      this.fetchBaseChannelLogs(baseFrom),
      this.fetchCurrentTotalFlowRate(),
      this.fetchBaseLatestBlock()
    ]);

    const blockTimestamps = await this.fetchCeloBlockTimestamps(celoEvents);
    const updates = this.buildDailyUpdates(celoEvents, baseResult.events, blockTimestamps, totalFlowRate);

    for (const [date, update] of updates) {
      await this.mergeDailyRecord(date, update);
    }

    await this.updateGlobalTotals();

    const newLastRun: AnalyticsLastRun = {
      celoBlock: latestCeloBlock,
      baseBlock: Math.max(lastRun?.baseBlock ?? 0, baseResult.latestBlock, latestBaseBlock),
      timestamp: new Date().toISOString()
    };
    await this.kv.put(LAST_RUN_KEY, JSON.stringify(newLastRun));

    logInfo("analytics.run.end", {
      celoFrom,
      latestCeloBlock,
      baseFrom,
      latestBaseBlock: newLastRun.baseBlock,
      celoEvents: celoEvents.length,
      baseEvents: baseResult.events.length,
      totalFlowRate: totalFlowRate.toString(),
      daysUpdated: updates.size,
      elapsedMs: Date.now() - startedAt
    });
  }

  /**
   * Return the last `days` of daily analytics plus current global totals.
   */
  async getAnalytics(days = 30): Promise<AnalyticsResponse> {
    const today = utcDate(new Date());
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      dates.push(offsetDate(today, -i));
    }

    const dailyRecords = await Promise.all(
      dates.map(async (date) => {
        const record = await this.getJson<DailyAnalytics>(`${DAILY_PREFIX}${date}`);
        return record ?? emptyDailyRecord(date);
      })
    );

    const global = await this.getJson<GlobalAnalytics>(GLOBAL_KEY);
    return {
      days: dailyRecords,
      global: global ?? emptyGlobalRecord()
    };
  }

  private async getLastRun(): Promise<AnalyticsLastRun | undefined> {
    return this.getJson<AnalyticsLastRun>(LAST_RUN_KEY);
  }

  private async mergeDailyRecord(date: string, update: Partial<DailyAnalytics>): Promise<void> {
    const key = `${DAILY_PREFIX}${date}`;
    const existing = await this.getJson<DailyAnalytics>(key) ?? emptyDailyRecord(date);

    const merged: DailyAnalytics = {
      date,
      gdOneTimeDeposits: (BigInt(existing.gdOneTimeDeposits) + BigInt(update.gdOneTimeDeposits ?? 0n)).toString(),
      gdStreamed: (BigInt(existing.gdStreamed) + BigInt(update.gdStreamed ?? 0n)).toString(),
      gdTotalFlowRate: update.gdTotalFlowRate?.toString() ?? existing.gdTotalFlowRate,
      aiCreditsUsed: (BigInt(existing.aiCreditsUsed) + BigInt(update.aiCreditsUsed ?? 0n)).toString(),
      uniqueGdBuyers: Math.max(existing.uniqueGdBuyers, update.uniqueGdBuyers ?? 0),
      uniqueCreditUsers: Math.max(existing.uniqueCreditUsers, update.uniqueCreditUsers ?? 0)
    };

    await this.kv.put(key, JSON.stringify(merged));
  }

  private async updateGlobalTotals(): Promise<void> {
    const keys = await this.listJsonKeys(DAILY_PREFIX);

    let gdOneTimeDeposits = 0n;
    let gdStreamed = 0n;
    let gdTotalFlowRate = 0n;
    let aiCreditsUsed = 0n;
    const uniqueGdBuyers = new Set<string>();
    const uniqueCreditUsers = new Set<string>();

    for (const key of keys) {
      const record = await this.getJson<DailyAnalytics>(key);
      if (!record) continue;
      gdOneTimeDeposits += BigInt(record.gdOneTimeDeposits);
      gdStreamed += BigInt(record.gdStreamed);
      gdTotalFlowRate = BigInt(record.gdTotalFlowRate); // latest day wins
      aiCreditsUsed += BigInt(record.aiCreditsUsed);
      // Daily records do not persist buyer/user wallet sets, so global unique
      // counts are approximated by the per-day unique counts. This matches the
      // current KV schema and avoids storing unbounded wallet sets.
      for (let i = 0; i < record.uniqueGdBuyers; i++) uniqueGdBuyers.add(`${key}:buyer:${i}`);
      for (let i = 0; i < record.uniqueCreditUsers; i++) uniqueCreditUsers.add(`${key}:user:${i}`);
    }

    const global: GlobalAnalytics = {
      gdOneTimeDeposits: gdOneTimeDeposits.toString(),
      gdStreamed: gdStreamed.toString(),
      gdTotalFlowRate: gdTotalFlowRate.toString(),
      aiCreditsUsed: aiCreditsUsed.toString(),
      uniqueGdBuyers: uniqueGdBuyers.size,
      uniqueCreditUsers: uniqueCreditUsers.size
    };
    await this.kv.put(GLOBAL_KEY, JSON.stringify(global));
  }

  private buildDailyUpdates(celoEvents: CeloVaultLog[], baseEvents: BaseChannelLog[], blockTimestamps: Map<number, number>, totalFlowRate: bigint): Map<
    string,
    DailyAnalytics
  > {
    const updates = new Map<string, DailyAnalytics>();

    for (const event of celoEvents) {
      const timestamp = blockTimestamps.get(event.blockNumber);
      if (timestamp === undefined) continue;
      const date = utcDate(new Date(timestamp * 1000));
      const current = updates.get(date) ?? emptyDailyRecord(date);

      if (event.kind === "deposit") {
        current.gdOneTimeDeposits = (BigInt(current.gdOneTimeDeposits) + event.gdAmountWei).toString();
      } else {
        current.gdStreamed = (BigInt(current.gdStreamed) + event.streamedAmountWei).toString();
      }

      // Count unique buyer per day: store buyer in a temporary set on the record object.
      const buyers = getSet(current, "__gdBuyers");
      buyers.add(event.buyer);
      current.uniqueGdBuyers = buyers.size;
      current.gdTotalFlowRate = totalFlowRate.toString();
      updates.set(date, current);
    }

    for (const event of baseEvents) {
      const date = utcDate(new Date(event.timestamp * 1000));
      const current = updates.get(date) ?? emptyDailyRecord(date);

      if (event.kind === "ChannelSettled" || event.kind === "ChannelClosed") {
        current.aiCreditsUsed = (BigInt(current.aiCreditsUsed) + event.settledAmount).toString();
      }

      const users = getSet(current, "__creditUsers");
      users.add(event.buyer);
      current.uniqueCreditUsers = users.size;
      current.gdTotalFlowRate = totalFlowRate.toString();
      updates.set(date, current);
    }

    return updates;
  }

  private async fetchCeloBlockTimestamps(celoEvents: CeloVaultLog[]): Promise<Map<number, number>> {
    const blockNumbers = new Set<number>();
    for (const event of celoEvents) blockNumbers.add(event.blockNumber);

    const timestamps = new Map<number, number>();
    await Promise.all(
      Array.from(blockNumbers).map(async (blockNumber) => {
        if (!this.cfg.CELO_RPC_URL) return;
        try {
          const timestamp = await this.fetchBlockTimestamp(this.cfg.CELO_RPC_URL, blockNumber);
          if (timestamp !== undefined) timestamps.set(blockNumber, timestamp);
        } catch (error) {
          logWarn("analytics.block.timestamp.failed", {
            blockNumber,
            chain: "celo",
            message: errorMessage(error)
          });
        }
      })
    );
    return timestamps;
  }

  private async fetchCeloVaultLogs(fromBlock: number, toBlock: number): Promise<CeloVaultLog[]> {
    if (!this.cfg.CELO_RPC_URL || !this.cfg.CELO_VAULT_ADDRESS) {
      logWarn("analytics.celo.skipped", { reason: "missing_config" });
      return [];
    }
    if (fromBlock > toBlock) return [];

    const depositEvent = VAULT_EVENTS.getEvent("GdDeposited")!;
    const streamEvent = VAULT_EVENTS.getEvent("StreamUpdated")!;

    try {
      const logs = await this.rpc<RpcLog[]>(this.cfg.CELO_RPC_URL, "eth_getLogs", [{
        address: this.cfg.CELO_VAULT_ADDRESS,
        fromBlock: toHex(fromBlock),
        toBlock: toHex(toBlock),
        topics: [[depositEvent.topicHash, streamEvent.topicHash]]
      }]);
      return this.parseCeloLogs(logs ?? []);
    } catch (error) {
      logError("analytics.celo.fetch.failed", { message: errorMessage(error) });
      return [];
    }
  }

  private channelEventSignatures(): string[] {
    return [
      "Reserved(bytes32,address,address,uint128,bytes32,uint256)",
      "ChannelSettled(bytes32,address,uint256)",
      "ChannelClosed(bytes32,address,uint256)",
      "ChannelTopUp(bytes32,address,uint256)",
      "ChannelWithdrawn(bytes32,address,uint256)",
      "CloseRequested(bytes32,address,uint256)"
    ];
  }

  private channelEventTopic0(): string {
    return this.channelEventSignatures()
      .map((sig) => ANTSEED_CHANNELS_ABI.getEvent(sig)?.topicHash)
      .filter(Boolean)
      .join(",");
  }

  private async fetchBaseChannelLogs(fromBlock: number): Promise<{ events: BaseChannelLog[]; latestBlock: number }> {
    const baseUrl = this.cfg.BASE_BLOCKSCOUT_URL;
    const address = this.cfg.ANTSEED_CHANNELS_ADDRESS;
    if (!baseUrl) {
      logWarn("analytics.base.skipped", { reason: "missing_blockscout" });
      return { events: [], latestBlock: 0 };
    }
    if (!address) {
      logWarn("analytics.base.skipped", { reason: "missing_channels_address" });
      return { events: [], latestBlock: 0 };
    }

    const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v2/addresses/${address}/logs`;
    const events: BaseChannelLog[] = [];
    const topic0 = this.channelEventTopic0();
    let nextPage: Record<string, string | number | undefined> | undefined = { from_block: fromBlock, topic0 };

    try {
      while (nextPage) {
        const url = new URL(endpoint);
        for (const [key, value] of Object.entries(nextPage)) {
          if (value !== undefined) url.searchParams.set(key, String(value));
        }
        if (!url.searchParams.has("topic0")) url.searchParams.set("topic0", topic0);
        const response = await this.fetchImpl(url.toString());
        if (!response.ok) throw new Error(`Blockscout HTTP ${response.status}`);
        const body = (await response.json()) as {
          items?: BlockscoutLog[];
          next_page_params?: Record<string, string | number | undefined> | null;
        };
        events.push(...this.parseBaseBlockscoutLogs(body.items ?? []));
        nextPage = body.next_page_params ?? undefined;
      }
      const latestBlock = events.reduce((max, event) => Math.max(max, event.blockNumber), 0);
      return { events, latestBlock };
    } catch (error) {
      logError("analytics.base.fetch.failed", { message: errorMessage(error) });
      return { events: [], latestBlock: 0 };
    }
  }

  private async fetchBaseLatestBlock(): Promise<number> {
    const baseUrl = this.cfg.BASE_BLOCKSCOUT_URL;
    if (!baseUrl) return 0;
    try {
      const response = await this.fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/v2/blocks?items_count=1`);
      if (!response.ok) throw new Error(`Blockscout HTTP ${response.status}`);
      const body = (await response.json()) as { items?: Array<{ height?: string | number; number?: string | number }> };
      const first = body.items?.[0];
      return asInteger(first?.height ?? first?.number) ?? 0;
    } catch (error) {
      logWarn("analytics.base.latestBlock.failed", { message: errorMessage(error) });
      return 0;
    }
  }

  private parseBaseBlockscoutLogs(items: BlockscoutLog[]): BaseChannelLog[] {
    return items
      .map((item): BaseChannelLog | undefined => {
        try {
          const decoded = ANTSEED_CHANNELS_ABI.parseLog({
            topics: item.topics,
            data: item.data
          });
          if (!decoded) return undefined;
          const buyer = getAddress(decoded.args.buyer).toLowerCase();
          const blockNumber = asInteger(item.block_number ?? item.blockNumber);
          const timestamp = parseTimestamp(item.block_timestamp ?? item.timestamp ?? item.block?.timestamp);
          if (blockNumber === undefined || timestamp === undefined) return undefined;
          if (decoded.name === "ChannelSettled" || decoded.name === "ChannelClosed") {
            return {
              kind: decoded.name,
              channelId: String(decoded.args.channelId),
              buyer,
              settledAmount: BigInt(decoded.args.settledAmount.toString()),
              blockNumber,
              timestamp
            };
          }
          return {
            kind: decoded.name as Exclude<BaseChannelLog["kind"], "ChannelSettled" | "ChannelClosed">,
            channelId: String(decoded.args.channelId),
            buyer,
            blockNumber,
            timestamp
          };
        } catch {
          return undefined;
        }
      })
      .filter((item): item is BaseChannelLog => Boolean(item));
  }

  private parseCeloLogs(logs: RpcLog[]): CeloVaultLog[] {
    const normalizedVault = this.cfg.CELO_VAULT_ADDRESS ? getAddress(this.cfg.CELO_VAULT_ADDRESS) : "";
    const parsed: CeloVaultLog[] = [];

    for (const log of logs) {
      if (normalizedVault && getAddress(log.address) !== normalizedVault) continue;
      try {
        const decoded = VAULT_EVENTS.parseLog({ topics: log.topics, data: log.data });
        if (!decoded) continue;
        const blockNumber = Number(log.blockNumber);
        if (decoded.name === "GdDeposited") {
          parsed.push({
            kind: "deposit",
            buyer: getAddress(decoded.args.buyer).toLowerCase(),
            gdAmountWei: BigInt(decoded.args.gdAmount.toString()),
            blockNumber
          });
        } else if (decoded.name === "StreamUpdated") {
          parsed.push({
            kind: "stream",
            buyer: getAddress(decoded.args.buyer).toLowerCase(),
            streamedAmountWei: BigInt(decoded.args.totalFlowWei.toString()),
            blockNumber
          });
        }
      } catch {
        // ignore undecodable logs
      }
    }
    return parsed;
  }

  private async fetchCurrentTotalFlowRate(): Promise<bigint> {
    if (!this.cfg.CELO_VAULT_ADDRESS || !this.cfg.CELO_GD_SUPERTOKEN_ADDRESS || !this.cfg.SUPERFLUID_SUBGRAPH_URL) {
      logWarn("analytics.flowRate.skipped", { reason: "missing_config" });
      return 0n;
    }

    const receiver = this.cfg.CELO_VAULT_ADDRESS.toLowerCase();
    const token = this.cfg.CELO_GD_SUPERTOKEN_ADDRESS.toLowerCase();

    try {
      const response = await this.fetchImpl(this.cfg.SUPERFLUID_SUBGRAPH_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `
            query TotalIncomingFlowRate($receiver: String!, $token: String!) {
              streams(where: { receiver: $receiver, token: $token, currentFlowRate_gt: "0" }) {
                currentFlowRate
              }
            }
          `,
          variables: { receiver, token }
        })
      });

      if (!response.ok) throw new Error(`Superfluid subgraph HTTP ${response.status}`);
      const body = (await response.json()) as {
        data?: { streams?: Array<{ currentFlowRate: string }> };
      };
      const streams = body.data?.streams ?? [];
      const total = streams.reduce((sum, stream) => sum + BigInt(stream.currentFlowRate), 0n);
      logInfo("analytics.flowRate", { total: total.toString(), streams: streams.length });
      return total;
    } catch (error) {
      logError("analytics.flowRate.failed", { message: errorMessage(error) });
      return 0n;
    }
  }

  private async fetchBlockTimestamp(rpcUrl: string | undefined, blockNumber: number): Promise<number | undefined> {
    if (!rpcUrl) return undefined;
    const block = await this.rpc<{ timestamp: string } | null>(rpcUrl, "eth_getBlockByNumber", [toHex(blockNumber), false]);
    if (!block) return undefined;
    return Number(block.timestamp);
  }

  private async getLatestBlockNumber(rpcUrl: string | undefined): Promise<number> {
    if (!rpcUrl) return 0;
    const blockNumber = await this.rpc<string>(rpcUrl, "eth_blockNumber", []);
    return Number(blockNumber);
  }

  private async rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? "RPC error");
    return body.result as T;
  }

  private async getJson<T>(key: string): Promise<T | undefined> {
    const value = await this.kv.get(key, "json");
    return (value ?? undefined) as T | undefined;
  }

  private async listJsonKeys(prefix: string): Promise<string[]> {
    // KVNamespace.list is not part of the Pick<KVNamespace, "get" | "put"> used in tests.
    // For production KVNamespace it exists. We cast to access it when available.
    const kv = this.kv as KVNamespace;
    if (typeof kv.list !== "function") return [];
    const result = await kv.list({ prefix });
    return result.keys.map((k) => k.name);
  }
}

function emptyDailyRecord(date: string): DailyAnalytics {
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

function emptyGlobalRecord(): GlobalAnalytics {
  return {
    gdOneTimeDeposits: "0",
    gdStreamed: "0",
    gdTotalFlowRate: "0",
    aiCreditsUsed: "0",
    uniqueGdBuyers: 0,
    uniqueCreditUsers: 0
  };
}

function toHex(n: number): string {
  return `0x${n.toString(16)}`;
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function offsetDate(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getSet(record: DailyAnalytics, key: "__gdBuyers" | "__creditUsers"): Set<string> {
  const existing = (record as unknown as Record<string, unknown>)[key];
  if (existing instanceof Set) return existing;
  const set = new Set<string>();
  (record as unknown as Record<string, unknown>)[key] = set;
  return set;
}

type CeloVaultLog =
  | { kind: "deposit"; buyer: string; gdAmountWei: bigint; blockNumber: number }
  | { kind: "stream"; buyer: string; streamedAmountWei: bigint; blockNumber: number };

type BaseChannelLog =
  | { kind: "Reserved" | "ChannelTopUp" | "ChannelWithdrawn" | "CloseRequested"; channelId: string; buyer: string; blockNumber: number; timestamp: number }
  | {
    kind: "ChannelSettled" | "ChannelClosed";
    channelId: string;
    buyer: string;
    settledAmount: bigint;
    blockNumber: number;
    timestamp: number;
  };

type RpcLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string | number;
  transactionHash?: string;
  logIndex?: string | number;
};

type BlockscoutLog = {
  address: string;
  topics: string[];
  data: string;
  block_number?: string | number;
  blockNumber?: string | number;
  block_timestamp?: string | number;
  timestamp?: string | number;
  block?: { timestamp?: string | number };
};

function asInteger(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (/^0x/i.test(value)) {
    const n = Number.parseInt(value, 16);
    return Number.isNaN(n) ? undefined : n;
  }
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? undefined : n;
}

function parseTimestamp(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
  if (/^0x/i.test(value)) {
    const ts = Number.parseInt(value, 16);
    return Number.isNaN(ts) ? undefined : ts;
  }
  if (/^\d+$/.test(value)) {
    const ts = Number.parseInt(value, 10);
    return ts > 1_000_000_000_000 ? Math.floor(ts / 1000) : ts;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

export { ANTSEED_CHANNELS_ABI };
