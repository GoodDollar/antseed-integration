import { Interface, LogDescription, getAddress } from "ethers";
import { RuntimeConfig } from "./env.js";
import { gdWeiToMicroUsd } from "./credit-bonus.js";

const VAULT_EVENTS = new Interface([
  "event GdDeposited(address indexed account,address indexed payer,uint256 gdAmount,bytes data)",
  "event StreamUpdated(address indexed account,int96 flowRate,uint256 monthlyGdAmountWei)"
]);

export type ParsedCeloVaultEvent =
  | {
      kind: "deposit";
      account: string;
      payer: string;
      gdAmountWei: bigint;
      principalMicroUsd: bigint;
      txHash: string;
      logIndex: number;
    }
  | {
      kind: "stream";
      account: string;
      flowRateWeiPerSecond: bigint;
      monthlyGdAmountWei: bigint;
      txHash: string;
      logIndex: number;
    };

export async function fetchCeloVaultEvents(txHash: string, cfg: RuntimeConfig): Promise<ParsedCeloVaultEvent[]> {
  if (!cfg.CELO_RPC_URL) throw new Error("CELO_RPC_URL is required to verify Celo vault events");
  if (!cfg.CELO_VAULT_ADDRESS) throw new Error("CELO_VAULT_ADDRESS is required to verify Celo vault events");

  const receipt = await rpc<{ logs: RpcLog[] }>(cfg.CELO_RPC_URL, "eth_getTransactionReceipt", [txHash]);
  if (!receipt) throw new Error(`transaction receipt not found: ${txHash}`);
  return parseCeloVaultLogs(receipt.logs, cfg.CELO_VAULT_ADDRESS, cfg.GD_MICRO_USD_PER_TOKEN);
}

export function parseCeloVaultLogs(logs: RpcLog[], vaultAddress: string, gdMicroUsdPerToken: bigint): ParsedCeloVaultEvent[] {
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
        payer: decoded.args.payer,
        gdAmountWei,
        principalMicroUsd: gdWeiToMicroUsd(gdAmountWei, gdMicroUsdPerToken),
        txHash: log.transactionHash,
        logIndex: Number(log.logIndex)
      });
    }

    if (decoded.name === "StreamUpdated") {
      parsed.push({
        kind: "stream",
        account: decoded.args.account,
        flowRateWeiPerSecond: BigInt(decoded.args.flowRate.toString()),
        monthlyGdAmountWei: BigInt(decoded.args.monthlyGdAmountWei.toString()),
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

type RpcLog = {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: string | number;
};

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
