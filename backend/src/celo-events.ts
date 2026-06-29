import { Interface, LogDescription, getAddress, isAddress, zeroPadValue } from "ethers";
import { RuntimeConfig } from "./env.js";

const VAULT_EVENTS = new Interface([
  "event GdDeposited(address indexed account,address indexed buyer,uint256 gdAmount,bytes data)",
  "event StreamUpdated(address indexed account,address indexed buyer,int96 flowRate,uint256 monthlyGdAmountWei,uint256 totalFlowWei)"
]);

const GOODID_ABI = new Interface([
  "function getWhitelistedRoot(address account) view returns (address)"
]);

const DEFAULT_STATIC_ORACLE_ADDRESS = "0x00851A91a3c4E9a4c1B48df827Bacc1f884bdE28";
const DEFAULT_CUSD_ADDRESS = "0x765DE816845861e75A25fCA122bb6898B8B1282a";

const STATIC_ORACLE_ABI = new Interface([
  "function quoteAllAvailablePoolsWithTimePeriod(uint128 baseAmount, address baseToken, address quoteToken, uint32 period) view returns (uint256 quoteAmount, address[] queriedPools)"
]);

export type ParsedCeloVaultEvent =
  | {
    kind: "deposit";
    account: string;
    buyer: string;
    gdAmountWei: bigint;
    txHash: string;
    logIndex: number;
  }
  | {
    kind: "stream";
    account: string;
    buyer: string;
    flowRateWeiPerSecond: bigint;
    monthlyGdAmountWei: bigint;
    totalFlowWei: bigint;
    txHash: string;
    logIndex: number;
  };

export async function fetchGoodIdRoot(account: string, cfg: RuntimeConfig): Promise<string | undefined> {
  if (!cfg.CELO_RPC_URL || !cfg.CELO_GOODID_ADDRESS) return normalizeAccount(account);
  const data = GOODID_ABI.encodeFunctionData("getWhitelistedRoot", [account]);
  const result = await rpc<string>(cfg.CELO_RPC_URL, "eth_call", [{ to: cfg.CELO_GOODID_ADDRESS, data }, "latest"]);
  if (!result || result === "0x") return normalizeAccount(account);
  const [root] = GOODID_ABI.decodeFunctionResult("getWhitelistedRoot", result);
  const rootString = String(root);
  return isAddress(rootString) && rootString !== "0x0000000000000000000000000000000000000000" ? normalizeAccount(rootString) : undefined;
}

export async function fetchCeloVaultEvents(txHash: string, cfg: RuntimeConfig): Promise<ParsedCeloVaultEvent[]> {
  if (!cfg.CELO_RPC_URL) throw new Error("CELO_RPC_URL is required to verify Celo vault events");
  if (!cfg.CELO_VAULT_ADDRESS) throw new Error("CELO_VAULT_ADDRESS is required to verify Celo vault events");

  const receipt = await rpc<{ logs: RpcLog[] }>(cfg.CELO_RPC_URL, "eth_getTransactionReceipt", [txHash]);
  if (!receipt) throw new Error(`transaction receipt not found: ${txHash}`);
  return parseCeloVaultLogs(receipt.logs, cfg.CELO_VAULT_ADDRESS);
}

export async function fetchCeloVaultEventsForAccount(
  account: string,
  cfg: RuntimeConfig,
  fromBlock: string,
  toBlock = "latest"
): Promise<ParsedCeloVaultEvent[]> {
  if (!cfg.CELO_RPC_URL) throw new Error("CELO_RPC_URL is required to verify Celo vault events");
  if (!cfg.CELO_VAULT_ADDRESS) throw new Error("CELO_VAULT_ADDRESS is required to verify Celo vault events");
  const depositEvent = VAULT_EVENTS.getEvent("GdDeposited");
  const streamEvent = VAULT_EVENTS.getEvent("StreamUpdated");
  if (!depositEvent || !streamEvent) throw new Error("vault event ABI missing");
  const accountTopic = zeroPadValue(account, 32);
  const logs = await rpc<RpcLog[]>(cfg.CELO_RPC_URL, "eth_getLogs", [{
    address: cfg.CELO_VAULT_ADDRESS,
    fromBlock,
    toBlock,
    topics: [[depositEvent.topicHash, streamEvent.topicHash], [accountTopic]]
  }]);
  return parseCeloVaultLogs(logs, cfg.CELO_VAULT_ADDRESS);
}

/**
 * Fetch the current G$ price in cUSD as a decimal number (e.g. 0.001154).
 * Uses the StaticOracle `quoteAllAvailablePoolsWithTimePeriod` with a 60-second TWAP.
 * Falls back to `cfg.GD_CUSD_PRICE` if the oracle is unavailable or returns zero.
 */
export async function fetchCurrentGdPrice(cfg: RuntimeConfig): Promise<number> {
  if (!cfg.CELO_RPC_URL || !cfg.CELO_GD_SUPERTOKEN_ADDRESS) return cfg.GD_CUSD_PRICE;
  const oracleAddress = cfg.CELO_STATIC_ORACLE_ADDRESS ?? DEFAULT_STATIC_ORACLE_ADDRESS;
  const cusdAddress = cfg.CELO_CUSD_ADDRESS ?? DEFAULT_CUSD_ADDRESS;
  const data = STATIC_ORACLE_ABI.encodeFunctionData("quoteAllAvailablePoolsWithTimePeriod", [
    1_000_000_000_000_000_000n,
    cfg.CELO_GD_SUPERTOKEN_ADDRESS,
    cusdAddress,
    60
  ]);
  try {
    const result = await rpc<string>(cfg.CELO_RPC_URL, "eth_call", [{ to: oracleAddress, data }, "latest"]);
    if (!result || result === "0x") return cfg.GD_CUSD_PRICE;
    const [quoteAmount] = STATIC_ORACLE_ABI.decodeFunctionResult("quoteAllAvailablePoolsWithTimePeriod", result);
    const price = Number(BigInt(quoteAmount.toString())) / 1e18;
    return price > 0 ? price : cfg.GD_CUSD_PRICE;
  } catch {
    return cfg.GD_CUSD_PRICE;
  }
}

export function parseCeloVaultLogs(logs: RpcLog[], vaultAddress: string): ParsedCeloVaultEvent[] {
  const normalizedVault = getAddress(vaultAddress);
  const parsed: ParsedCeloVaultEvent[] = [];

  for (const log of logs) {
    if (getAddress(log.address) !== normalizedVault) continue;
    let decoded: LogDescription | null = null;
    try {
      decoded = VAULT_EVENTS.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (!decoded) continue;

    if (decoded.name === "GdDeposited") {
      const gdAmountWei = BigInt(decoded.args.gdAmount.toString());
      parsed.push({
        kind: "deposit",
        account: decoded.args.account,
        buyer: getAddress(decoded.args.buyer).toLowerCase(),
        gdAmountWei,
        txHash: log.transactionHash,
        logIndex: Number(log.logIndex)
      });
    }

    if (decoded.name === "StreamUpdated") {
      parsed.push({
        kind: "stream",
        account: decoded.args.account,
        buyer: getAddress(decoded.args.buyer).toLowerCase(),
        flowRateWeiPerSecond: BigInt(decoded.args.flowRate.toString()),
        monthlyGdAmountWei: BigInt(decoded.args.monthlyGdAmountWei.toString()),
        totalFlowWei: BigInt(decoded.args.totalFlowWei.toString()),
        txHash: log.transactionHash,
        logIndex: Number(log.logIndex)
      });
    }
  }

  return parsed;
}

export function encodeVaultEventLog(eventName: "GdDeposited" | "StreamUpdated", args: readonly unknown[], address: string, txHash: string, logIndex: number): RpcLog {
  const event = VAULT_EVENTS.getEvent(eventName);
  if (!event) throw new Error(`unknown event ${eventName}`);
  const encoded = VAULT_EVENTS.encodeEventLog(event, args);
  return {
    address,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: txHash,
    logIndex: `0x${logIndex.toString(16)}`
  };
}

/**
 * Decode an AntSeed buyer address from ABI-encoded Superfluid userdata.
 * userdata is expected to be `abi.encode(address)` — 32 bytes, address right-aligned.
 * Returns the lowercase checksummed address, or undefined if absent/invalid.
 */
export function decodeBuyerFromUserData(userData: string | undefined): string | undefined {
  // Expect "0x" + 64 hex chars (32 bytes)
  if (!userData || userData === "0x" || userData.length < 66) return undefined;
  try {
    // First 12 bytes (24 hex chars after "0x") are zero-padding; last 20 bytes are the address
    const addressHex = "0x" + userData.slice(26, 66);
    if (!isAddress(addressHex) || addressHex === "0x0000000000000000000000000000000000000000") return undefined;
    return getAddress(addressHex).toLowerCase();
  } catch {
    return undefined;
  }
}

type RpcLog = {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: string | number;
};

function normalizeAccount(account: string): string {
  return getAddress(account).toLowerCase();
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!res.ok) throw new Error(`Celo RPC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "Celo RPC error");
  return body.result as T;
}
