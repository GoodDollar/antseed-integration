import { ZeroHash, ethers, id } from "ethers";
import { Config } from "./config.js";

const ABI = [
  "function availableBalance(address account) view returns (uint256)",
  "function balances(address account) view returns (uint256)",
  "function reservedBalances(address account) view returns (uint256)",
  "function reserve(bytes32 requestId, address account, uint256 amount, bytes32 metadataHash) returns (uint256)",
  "function settle(bytes32 requestId, uint256 actualCost, bytes32 providerReceiptHash) returns (uint256)",
  "function release(bytes32 requestId) returns (uint256)"
] as const;

export type VaultBalances = {
  enabled: boolean;
  balance: string;
  reserved: string;
  available: string;
};

export class VaultClient {
  readonly enabled: boolean;
  private contract?: ethers.Contract;

  constructor(private readonly cfg: Config) {
    this.enabled = Boolean(cfg.RPC_URL && cfg.VAULT_ADDRESS && cfg.OPERATOR_PRIVATE_KEY);
    if (this.enabled) {
      const provider = new ethers.JsonRpcProvider(cfg.RPC_URL);
      const signer = new ethers.Wallet(cfg.OPERATOR_PRIVATE_KEY!, provider);
      this.contract = new ethers.Contract(cfg.VAULT_ADDRESS!, ABI, signer);
    }
  }

  async balances(account: string): Promise<VaultBalances> {
    if (!this.contract) return { enabled: false, balance: "0", reserved: "0", available: "0" };
    const [balance, reserved, available] = await Promise.all([
      this.contract.balances(account),
      this.contract.reservedBalances(account),
      this.contract.availableBalance(account)
    ]);
    return { enabled: true, balance: balance.toString(), reserved: reserved.toString(), available: available.toString() };
  }

  async reserve(requestId: string, account: string, amountMicroUsd: bigint, metadata?: unknown): Promise<string | undefined> {
    if (!this.contract) return undefined;
    const tx = await this.contract.reserve(toBytes32(requestId), account, amountMicroUsd, metadata ? hashJson(metadata) : ZeroHash);
    const receipt = await tx.wait();
    return receipt?.hash;
  }

  async settle(requestId: string, actualCostMicroUsd: bigint, receiptHash: string): Promise<string | undefined> {
    if (!this.contract) return undefined;
    const tx = await this.contract.settle(toBytes32(requestId), actualCostMicroUsd, receiptHash);
    const receipt = await tx.wait();
    return receipt?.hash;
  }

  async release(requestId: string): Promise<string | undefined> {
    if (!this.contract) return undefined;
    const tx = await this.contract.release(toBytes32(requestId));
    const receipt = await tx.wait();
    return receipt?.hash;
  }
}

function toBytes32(value: string): string {
  return id(value);
}

function hashJson(value: unknown): string {
  return id(JSON.stringify(value));
}
