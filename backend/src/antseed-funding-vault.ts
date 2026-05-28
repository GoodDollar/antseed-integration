import { ethers } from "ethers";
import { RuntimeConfig } from "./env.js";

const FUNDING_VAULT_ABI = [
  "function depositFor(address buyer, uint256 principal, uint256 bonus)",
  "function depositForWithId(address buyer, uint256 principal, uint256 bonus, string id)",
  "function requestClose(bytes32 channelId)",
  "function usedDepositIds(bytes32 id) view returns (bool)"
] as const;

export type AntSeedFundingResult = {
  enabled: boolean;
  buyer: string;
  amountMicroUsd: string;
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

  async depositForBuyer(buyer: string, principalMicroUsd: bigint, bonusMicroUsd: bigint): Promise<AntSeedFundingResult> {
    const total = principalMicroUsd + bonusMicroUsd;
    if (!this.contract) return { enabled: false, buyer, amountMicroUsd: total.toString() };
    const tx = await this.contract.depositFor(buyer, principalMicroUsd, bonusMicroUsd);
    const receipt = await tx.wait();
    return {
      enabled: true,
      buyer,
      amountMicroUsd: total.toString(),
      txHash: receipt?.hash
    };
  }

  async depositForBuyerWithId(buyer: string, principalMicroUsd: bigint, bonusMicroUsd: bigint, id: string): Promise<AntSeedFundingResult> {
    const total = principalMicroUsd + bonusMicroUsd;
    if (!this.contract) return { enabled: false, buyer, amountMicroUsd: total.toString() };

    const alreadyUsed = await this.contract.usedDepositIds(this.toBytes32Id(id));
    if (alreadyUsed) {
      return { enabled: true, buyer, amountMicroUsd: total.toString() };
    }

    const tx = await this.contract.depositForWithId(buyer, principalMicroUsd, bonusMicroUsd, id);
    const receipt = await tx.wait();
    return {
      enabled: true,
      buyer,
      amountMicroUsd: total.toString(),
      txHash: receipt?.hash
    };
  }

  async requestClose(channelId: string): Promise<{ enabled: boolean; txHash?: string }> {
    if (!this.contract) return { enabled: false };
    const tx = await this.contract.requestClose(channelId);
    const receipt = await tx.wait();
    return { enabled: true, txHash: receipt?.hash };
  }
}
