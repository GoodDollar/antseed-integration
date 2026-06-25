import { ethers } from "ethers";
import { RuntimeConfig } from "./env.js";

const FUNDING_VAULT_ABI = [
  "function depositFor(address buyer, uint256 principal, uint256 bonus)",
  "function depositForWithId(address buyer, uint256 principal, uint256 bonus, string id)",
  "function requestClose(bytes32 channelId)",
  "function withdrawChannel(bytes32 channelId)",
  "function withdrawPrincipal(address buyer, uint256 amount, address recipient, uint256 timestamp, bytes buyerSig)",
  "function withdrawablePrincipal(address buyer) view returns (uint256)",
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
  private provider?: ethers.JsonRpcProvider;
  private chainIdPromise?: Promise<number>;

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
      this.provider = new ethers.JsonRpcProvider(cfg.ANTSEED_FUNDING_RPC_URL);
      const signer = new ethers.Wallet(cfg.ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY!, this.provider);
      this.contract = new ethers.Contract(cfg.ANTSEED_FUNDING_VAULT_ADDRESS!, FUNDING_VAULT_ABI, signer);
    }
  }

  get vaultAddress(): string | undefined {
    return this.cfg.ANTSEED_FUNDING_VAULT_ADDRESS;
  }

  async getChainId(): Promise<number> {
    if (!this.provider) {
      throw new Error("bridge not configured");
    }
    if (!this.chainIdPromise) {
      this.chainIdPromise = this.provider.getNetwork().then((network) => Number(network.chainId));
    }
    return this.chainIdPromise;
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

  async withdrawChannel(channelId: string): Promise<{ enabled: boolean; txHash?: string }> {
    if (!this.contract) return { enabled: false };
    const tx = await this.contract.withdrawChannel(channelId);
    const receipt = await tx.wait();
    return { enabled: true, txHash: receipt?.hash };
  }

  async getWithdrawablePrincipal(buyer: string): Promise<{ enabled: boolean; buyer: string; withdrawableMicroUsd: string }> {
    const normalizedBuyer = buyer.toLowerCase();
    if (!this.contract) {
      return { enabled: false, buyer: normalizedBuyer, withdrawableMicroUsd: "0" };
    }
    const amount = await this.contract.withdrawablePrincipal(normalizedBuyer);
    return {
      enabled: true,
      buyer: normalizedBuyer,
      withdrawableMicroUsd: amount.toString()
    };
  }

  async withdrawPrincipal(
    buyer: string,
    amountMicroUsd: bigint,
    recipient: string,
    timestamp: bigint,
    buyerSig: string
  ): Promise<{ enabled: boolean; buyer: string; amountMicroUsd: string; recipient: string; txHash?: string }> {
    const normalizedBuyer = buyer.toLowerCase();
    const normalizedRecipient = recipient.toLowerCase();
    if (!this.contract) {
      return {
        enabled: false,
        buyer: normalizedBuyer,
        amountMicroUsd: amountMicroUsd.toString(),
        recipient: normalizedRecipient
      };
    }
    const tx = await this.contract.withdrawPrincipal(
      normalizedBuyer,
      amountMicroUsd,
      normalizedRecipient,
      timestamp,
      buyerSig
    );
    const receipt = await tx.wait();
    return {
      enabled: true,
      buyer: normalizedBuyer,
      amountMicroUsd: amountMicroUsd.toString(),
      recipient: normalizedRecipient,
      txHash: receipt?.hash
    };
  }
}
