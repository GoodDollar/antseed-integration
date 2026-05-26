import { ethers } from "ethers";
import { RuntimeConfig } from "./env.js";

const FUNDING_VAULT_ABI = [
  "function depositFor(address buyer, uint256 amount)"
] as const;

export type AntSeedFundingResult = {
  enabled: boolean;
  buyer: string;
  amountMicroUsd: string;
  txHash?: string;
};

export class AntSeedFundingVaultClient {
  readonly enabled: boolean;
  private contract?: ethers.Contract;

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

  async depositForBuyer(buyer: string, amountMicroUsd: bigint): Promise<AntSeedFundingResult> {
    if (!this.contract) return { enabled: false, buyer, amountMicroUsd: amountMicroUsd.toString() };
    const tx = await this.contract.depositFor(buyer, amountMicroUsd);
    const receipt = await tx.wait();
    return {
      enabled: true,
      buyer,
      amountMicroUsd: amountMicroUsd.toString(),
      txHash: receipt?.hash
    };
  }
}
