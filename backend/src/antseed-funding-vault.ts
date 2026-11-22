import { ethers } from "ethers";
import { RuntimeConfig } from "./env.js";
import { errorMessage, logError, logInfo, logWarn, redactAddress, redactHash } from "./logging.js";

const FUNDING_VAULT_ABI = [
  "function depositFor(address buyer, uint256 principal, uint256 bonus)",
  "function depositForWithId(address buyer, uint256 principal, uint256 bonus, string id)",
  "function acceptBuyerOperator(address buyer, uint256 nonce, bytes buyerSig)",
  "function revokeOperator(address buyer, uint256 nonce, bytes buyerSig)",
  "function withdrawPrincipal(address buyer, uint256 amount, address recipient, uint256 nonce, bytes buyerSig)",
  "function requestClose(bytes32 channelId, uint256 nonce, bytes buyerSig)",
  "function withdrawChannel(bytes32 channelId, uint256 nonce, bytes buyerSig)",
  "function registry() view returns (address)",
  "function usedDepositIds(bytes32 id) view returns (bool)"
] as const;
const REGISTRY_ABI = ["function deposits() view returns (address)"] as const;
const DEPOSITS_ABI = [
  "function getOperator(address buyer) view returns (address)",
  "function getBuyerBalance(address buyer) view returns (uint256 available, uint256 reserved, uint256 lastActivity)",
  "function MIN_BUYER_DEPOSIT() view returns (uint256)"
] as const;

/** A deposit must meet the protocol minimum when the buyer has no AntSeed balance. */
export class BuyerDepositBelowMinimum extends Error {
  override readonly name = "BuyerDepositBelowMinimum";

  constructor(readonly minimumUsd: bigint) {
    super(`Buyer has zero AntSeed balance; total deposit must be at least ${minimumUsd} micro-USD`);
  }
}

export type AntSeedFundingResult = {
  enabled: boolean;
  buyer: string;
  amountUsd: string;
  txHash?: string;
  alreadyFunded?: boolean;
  error?: string;
};

export class AntSeedFundingVaultClient {
  readonly enabled: boolean;
  private contract?: ethers.Contract;

  private toBytes32Id(id: string): string {
    return ethers.id(id);
  }

  constructor(private readonly cfg: RuntimeConfig) {
    this.enabled = Boolean(cfg.ANTSEED_FUNDING_RPC_URL && cfg.ANTSEED_FUNDING_VAULT_ADDRESS && cfg.ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY);
    if (this.enabled) {
      const provider = new ethers.JsonRpcProvider(cfg.ANTSEED_FUNDING_RPC_URL);
      const signer = new ethers.Wallet(cfg.ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY!, provider);
      this.contract = new ethers.Contract(cfg.ANTSEED_FUNDING_VAULT_ADDRESS!, FUNDING_VAULT_ABI, signer);
    }
    logInfo("funding.client.init", {
      enabled: this.enabled,
      vaultAddress: redactAddress(cfg.ANTSEED_FUNDING_VAULT_ADDRESS),
      hasRpcUrl: Boolean(cfg.ANTSEED_FUNDING_RPC_URL)
    });
  }

  async acceptBuyerOperator(buyer: string, nonce: bigint, signature: string): Promise<{ enabled: boolean; buyer: string; nonce: string; txHash?: string }> {
    const normalizedBuyer = buyer.toLowerCase();
    if (!this.contract) {
      return { enabled: false, buyer: normalizedBuyer, nonce: nonce.toString() };
    }
    const tx = await this.contract.acceptBuyerOperator(normalizedBuyer, nonce, signature);
    const receipt = await tx.wait();
    return {
      enabled: true,
      buyer: normalizedBuyer,
      nonce: nonce.toString(),
      txHash: receipt?.hash
    };
  }

  async revokeBuyerOperator(buyer: string, nonce: bigint, signature: string): Promise<{ enabled: boolean; buyer: string; nonce: string; txHash?: string }> {
    const normalizedBuyer = buyer.toLowerCase();
    if (!this.contract) {
      return { enabled: false, buyer: normalizedBuyer, nonce: nonce.toString() };
    }
    const tx = await this.contract.revokeOperator(normalizedBuyer, nonce, signature);
    const receipt = await tx.wait();
    return {
      enabled: true,
      buyer: normalizedBuyer,
      nonce: nonce.toString(),
      txHash: receipt?.hash
    };
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

  async depositForBuyerWithId(buyer: string, principalUsd: bigint, bonusUsd: bigint, id: string, requireMinimum = true): Promise<AntSeedFundingResult> {
    const total = principalUsd + bonusUsd;
    logInfo("funding.bridge.deposit.start", {
      buyer: redactAddress(buyer),
      principalUsd: principalUsd.toString(),
      bonusUsd: bonusUsd.toString(),
      totalUsd: total.toString(),
      id
    });
    if (!this.contract) {
      logWarn("funding.bridge.deposit.skipped", {
        reason: "bridge_disabled",
        buyer: redactAddress(buyer),
        id
      });
      return { enabled: false, buyer, amountUsd: total.toString() };
    }

    const idHash = this.toBytes32Id(id);
    const alreadyUsed = await this.contract.usedDepositIds(idHash);
    logInfo("funding.bridge.deposit.id-check", {
      id,
      idHash: redactHash(idHash),
      alreadyUsed
    });
    if (alreadyUsed) {
      logWarn("funding.bridge.deposit.duplicate", {
        id,
        idHash: redactHash(idHash),
        buyer: redactAddress(buyer)
      });
      return { enabled: true, buyer, amountUsd: total.toString(), alreadyFunded: true };
    }
    try {
      if (requireMinimum) {
        const deposits = await this.getDepositsContract();
        const [[available, reserved], minimum] = await Promise.all([deposits.getBuyerBalance(buyer), deposits.MIN_BUYER_DEPOSIT()]);
        if (BigInt(available) + BigInt(reserved) === 0n && total < BigInt(minimum)) {
          throw new BuyerDepositBelowMinimum(BigInt(minimum));
        }
      }
      let lastTxHash: string | undefined;
      let lastError: Error | undefined;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (attempt > 1) {
          const reconciled = await this.reconcileSubmittedDeposit(idHash, id, lastTxHash);
          if (reconciled) {
            return {
              enabled: true,
              buyer,
              amountUsd: total.toString(),
              txHash: lastTxHash,
              alreadyFunded: true
            };
          }
          logWarn("funding.bridge.deposit.retry", {
            id,
            buyer: redactAddress(buyer),
            attempt,
            previousTxHash: redactHash(lastTxHash),
            previousError: lastError ? errorMessage(lastError) : "missing receipt"
          });
        }
        const tx = await this.contract.depositForWithId(buyer, principalUsd, bonusUsd, id);
        lastTxHash = String(tx.hash);
        logInfo("funding.bridge.deposit.submitted", {
          id,
          buyer: redactAddress(buyer),
          txHash: redactHash(lastTxHash),
          attempt
        });
        try {
          const receipt = await tx.wait();
          if (receipt?.status === 1) {
            logInfo("funding.bridge.deposit.confirmed", {
              id,
              buyer: redactAddress(buyer),
              txHash: redactHash(receipt.hash),
              attempt
            });
            return {
              enabled: true,
              buyer,
              amountUsd: total.toString(),
              txHash: receipt.hash
            };
          }
          lastError = new Error(receipt ? `Base funding transaction reverted: ${lastTxHash}` : `Base funding transaction receipt missing: ${lastTxHash}`);
        } catch (confirmationError) {
          lastError = confirmationError instanceof Error ? confirmationError : new Error(errorMessage(confirmationError));
        }
      }
      const error = lastError ?? new Error(`Base funding transaction receipt missing: ${lastTxHash ?? "unknown"}`);
      if (lastTxHash) Object.assign(error, { fundingTxHash: lastTxHash });
      throw error;
    } catch (error) {
      const message = errorMessage(error);
      const fundingTxHash = error && typeof error === "object" && "fundingTxHash" in error ? String(error.fundingTxHash) : undefined;
      logError("funding.bridge.deposit.failed", {
        id,
        buyer: redactAddress(buyer),
        txHash: redactHash(fundingTxHash),
        message
      });
      throw error;
    }
  }

  private async reconcileSubmittedDeposit(idHash: string, id: string, txHash: string | undefined): Promise<boolean> {
    if (!this.contract) return false;
    try {
      const used = await this.contract.usedDepositIds(idHash);
      if (used) {
        logWarn("funding.bridge.deposit.reconciled-id", { id, submittedTxHash: redactHash(txHash) });
        return true;
      }
    } catch (reconciliationError) {
      logWarn("funding.bridge.deposit.reconcile-failed", { id, message: errorMessage(reconciliationError) });
    }
    return false;
  }

  /** Resolves the current deposits contract from the operator's authoritative registry. */
  private async getDepositsContract(): Promise<ethers.Contract> {
    if (!this.contract) throw new Error("Funding bridge is disabled");
    const registryAddress = await this.contract.registry();
    const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, this.contract.runner);
    const depositsAddress = await registry.deposits();
    return new ethers.Contract(depositsAddress, DEPOSITS_ABI, this.contract.runner);
  }

  async isBuyerOperator(buyer: string): Promise<{ enabled: boolean; buyer: string; isOperator: boolean }> {
    const normalizedBuyer = buyer.toLowerCase();
    if (!this.contract) return { enabled: false, buyer: normalizedBuyer, isOperator: false };

    const operatorAddress = await this.contract.getAddress();
    const deposits = await this.getDepositsContract();
    const currentOperator = await deposits.getOperator(normalizedBuyer);
    return {
      enabled: true,
      buyer: normalizedBuyer,
      isOperator: String(currentOperator).toLowerCase() === String(operatorAddress).toLowerCase()
    };
  }

  async withdrawPrincipalForBuyer(
    buyer: string,
    amountUsd: bigint,
    recipient: string,
    nonce: bigint,
    signature: string
  ): Promise<{ enabled: boolean; txHash?: string }> {
    if (!this.contract) return { enabled: false };
    const tx = await this.contract.withdrawPrincipal(buyer, amountUsd, recipient, nonce, signature);
    const receipt = await tx.wait();
    return { enabled: true, txHash: receipt?.hash };
  }

  async requestClose(channelId: string, nonce?: bigint, buyerSig?: string): Promise<{ enabled: boolean; txHash?: string }> {
    if (!this.contract) return { enabled: false };
    const tx = await this.contract.requestClose(channelId, nonce ?? 0n, buyerSig ?? "0x");
    const receipt = await tx.wait();
    return { enabled: true, txHash: receipt?.hash };
  }

  async withdrawFromChannel(channelId: string, nonce?: bigint, buyerSig?: string): Promise<{ enabled: boolean; txHash?: string }> {
    if (!this.contract) return { enabled: false };
    const tx = await this.contract.withdrawChannel(channelId, nonce ?? 0n, buyerSig ?? "0x");
    const receipt = await tx.wait();
    return { enabled: true, txHash: receipt?.hash };
  }
}
