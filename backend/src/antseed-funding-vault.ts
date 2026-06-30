import { ethers } from "ethers";
import { RuntimeConfig } from "./env.js";

const FUNDING_VAULT_ABI = [
  "function depositFor(address buyer, uint256 principal, uint256 bonus)",
  "function depositForWithId(address buyer, uint256 principal, uint256 bonus, string id)",
  "function withdrawPrincipal(address buyer, uint256 amount, address recipient, uint256 timestamp, bytes buyerSig)",
  "function requestClose(bytes32 channelId, uint256 timestamp, bytes buyerSig)",
  "function withdrawChannel(bytes32 channelId, uint256 timestamp, bytes buyerSig)",
  "function usedDepositIds(bytes32 id) view returns (bool)"
] as const;

export type AntSeedFundingResult = {
  enabled: boolean;
  buyer: string;
  amountUsd: string;
  txHash?: string;
  error?: string;
};

export class AntSeedFundingVaultClient {
  readonly enabled: boolean;
  private contract?: ethers.Contract;

  private toBytes32Id(id: string): string {
    return ethers.id(id);
  }

  constructor(private readonly cfg: RuntimeConfig) {
    this.enabled = Boolean(
      cfg.ANTSEED_FUNDING_RPC_URL &&
      cfg.ANTSEED_FUNDING_VAULT_ADDRESS &&
      cfg.ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY
    );
    if (this.enabled) {
      const provider = new ethers.JsonRpcProvider(cfg.ANTSEED_FUNDING_RPC_URL);
      const signer = new ethers.Wallet(cfg.ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY!, provider);
      this.contract = new ethers.Contract(cfg.ANTSEED_FUNDING_VAULT_ADDRESS!, FUNDING_VAULT_ABI, signer);
    }
  }

  async depositForBuyer(buyer: string, principalUsd: bigint, bonusUsd: bigint): Promise<AntSeedFundingResult> {
    const total = principalUsd + bonusUsd;
    if (!this.contract) return { enabled: false, buyer, amountUsd: total.toString() };
    const tx = await this.contract.depositFor(buyer, principalUsd, bonusUsd);
    const receipt = await tx.wait();
    return {
      enabled: true,
      buyer,
      amountUsd: total.toString(),
      txHash: receipt?.hash
    };
  }

  async depositForBuyerWithId(buyer: string, principalUsd: bigint, bonusUsd: bigint, id: string): Promise<AntSeedFundingResult> {
    const total = principalUsd + bonusUsd;
    if (!this.contract) return { enabled: false, buyer, amountUsd: total.toString() };

    const alreadyUsed = await this.contract.usedDepositIds(this.toBytes32Id(id));
    if (alreadyUsed) {
      return { enabled: true, buyer, amountUsd: total.toString() };
    }

    const tx = await this.contract.depositForWithId(buyer, principalUsd, bonusUsd, id);
    const receipt = await tx.wait();
    return {
      enabled: true,
      buyer,
      amountUsd: total.toString(),
      txHash: receipt?.hash
    };
  }

  async withdrawPrincipalForBuyer(buyer: string, amountUsd: bigint, recipient: string, timestamp: number, signature: string): Promise<{ enabled: boolean; txHash?: string }> {
    if (!this.contract) return { enabled: false };
    const tx = await this.contract.withdrawPrincipal(buyer, amountUsd, recipient, timestamp, signature);
    const receipt = await tx.wait();
    return { enabled: true, txHash: receipt?.hash };
  }

  async requestClose(channelId: string, timestamp?: number, buyerSig?: string): Promise<{ enabled: boolean; txHash?: string }> {
    if (!this.contract) return { enabled: false };
    const tx = await this.contract.requestClose(channelId, timestamp ?? 0, buyerSig ?? "0x");
    const receipt = await tx.wait();
    return { enabled: true, txHash: receipt?.hash };
  }

  async withdrawFromChannel(channelId: string, timestamp?: number, buyerSig?: string): Promise<{ enabled: boolean; txHash?: string }> {
    if (!this.contract) return { enabled: false };
    const tx = await this.contract.withdrawChannel(channelId, timestamp ?? 0, buyerSig ?? "0x");
    const receipt = await tx.wait();
    return { enabled: true, txHash: receipt?.hash };
  }
}
