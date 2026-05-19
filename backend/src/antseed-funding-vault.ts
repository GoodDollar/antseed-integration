import { ethers } from "ethers";
import { RuntimeConfig } from "./env.js";

const FUNDING_VAULT_ABI = [
  "function balance() view returns (uint256)",
  "function antSeedBuyerBalance() view returns (uint256 available, uint256 reserved, uint256 lastActivityAt)",
  "function fundAntSeedDeposit(uint256 amount) returns (uint256 availableAfter)"
] as const;

export type AntSeedBuyerDepositBalance = {
  available: string;
  reserved: string;
  lastActivityAt: string;
};

export type AntSeedFundingResult = {
  enabled: boolean;
  requiredMicroUsd: string;
  availableBefore?: string;
  topUpMicroUsd?: string;
  txHash?: string;
  availableAfter?: string;
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

  async buyerBalance(): Promise<AntSeedBuyerDepositBalance | undefined> {
    if (!this.contract) return undefined;
    const [available, reserved, lastActivityAt] = await this.contract.antSeedBuyerBalance();
    return {
      available: available.toString(),
      reserved: reserved.toString(),
      lastActivityAt: lastActivityAt.toString()
    };
  }

  async ensureBuyerBalance(requiredMicroUsd: bigint): Promise<AntSeedFundingResult> {
    if (!this.contract) return { enabled: false, requiredMicroUsd: requiredMicroUsd.toString() };

    const [available] = await this.contract.antSeedBuyerBalance();
    const availableBefore = BigInt(available.toString());
    const target = requiredMicroUsd > this.cfg.ANTSEED_MIN_BUYER_DEPOSIT_MICRO_USD
      ? requiredMicroUsd
      : this.cfg.ANTSEED_MIN_BUYER_DEPOSIT_MICRO_USD;

    if (availableBefore >= requiredMicroUsd) {
      return {
        enabled: true,
        requiredMicroUsd: requiredMicroUsd.toString(),
        availableBefore: availableBefore.toString(),
        topUpMicroUsd: "0",
        availableAfter: availableBefore.toString()
      };
    }

    const topUp = target - availableBefore;
    const tx = await this.contract.fundAntSeedDeposit(topUp);
    const receipt = await tx.wait();
    const [availableAfter] = await this.contract.antSeedBuyerBalance();
    return {
      enabled: true,
      requiredMicroUsd: requiredMicroUsd.toString(),
      availableBefore: availableBefore.toString(),
      topUpMicroUsd: topUp.toString(),
      txHash: receipt?.hash,
      availableAfter: availableAfter.toString()
    };
  }
}
