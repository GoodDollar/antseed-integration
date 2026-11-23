import { AntSeedFundingVaultClient } from "./antseed-funding-vault.js";
import { KVCreditStore } from "./kv-credit-store.js";
import { GdCreditEntry } from "./types.js";
import { errorMessage, logError, logInfo, logWarn, redactAddress, redactHash } from "./logging.js";
import type { FailureReporter } from "./http.js";
import type { RuntimeConfig } from "./env.js";

export async function retryFailedDeposits(
  store: KVCreditStore,
  antseedFundingVault: AntSeedFundingVaultClient,
  reportFailure?: FailureReporter,
  cfg?: RuntimeConfig
): Promise<{ found: number; retried: number; funded: number; failed: number }> {
  const failedDeposits = await store.getFailedDeposits();
  let retried = 0;
  let funded = 0;
  let failed = 0;

  for (const failedDeposit of failedDeposits) {
    retried += 1;

    try {
      const result = await fundCredit(failedDeposit, store, antseedFundingVault, reportFailure, cfg);
      if (result.fundingStatus === "funded") funded += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      await reportFailure?.({
        operation: "funding.deposit.retry",
        chain: "base",
        error,
        entryId: failedDeposit.id,
        buyer: failedDeposit.buyerAddress || failedDeposit.account
      });
    }
  }

  return { found: failedDeposits.length, retried, funded, failed };
}

export async function fundCredit(
  entry: GdCreditEntry,
  store: KVCreditStore,
  antseedFundingVault: AntSeedFundingVaultClient,
  reportFailureOrConfig?: FailureReporter | RuntimeConfig,
  cfg?: RuntimeConfig
): Promise<{ [key: string]: unknown }> {
  const reportFailure = typeof reportFailureOrConfig === "function" ? reportFailureOrConfig : reportFailureOrConfig?.reportFailure;
  const runtimeConfig = cfg ?? (typeof reportFailureOrConfig === "object" ? reportFailureOrConfig : undefined);
  const buyer = entry.buyerAddress || entry.account;
  if (entry.fundingStatus === "funded") {
    logInfo("funding.already-funded", {
      entryId: entry.id,
      source: entry.source,
      account: redactAddress(entry.account),
      buyer: redactAddress(buyer),
      fundingTxHash: redactHash(entry.fundingTxHash)
    });
    return {
      ...entry,
      bridge: {
        enabled: antseedFundingVault.enabled,
        buyer,
        amountUsd: entry.totalCreditUsd,
        txHash: entry.fundingTxHash,
        alreadyFunded: true
      }
    };
  }
  if (entry.fundingStatus === "failed") {
    if (runtimeConfig) {
      entry = await store.recalculateFundingAmounts(entry, runtimeConfig);
    }
    entry = await store.retryFailedFunding(entry);
  }
  const previousFundingTxHash = entry.fundingTxHash;
  const principalUsd = BigInt(entry.principalUsd);
  const bonusUsd = BigInt(entry.bonusUsd);
  logInfo("funding.start", {
    entryId: entry.id,
    source: entry.source,
    account: redactAddress(entry.account),
    buyer: redactAddress(buyer),
    principalUsd: entry.principalUsd,
    bonusUsd: entry.bonusUsd,
    totalCreditUsd: entry.totalCreditUsd
  });
  try {
    const shouldCredit = principalUsd + bonusUsd > 0n;
    const bridge = shouldCredit
      ? await antseedFundingVault.depositForBuyerWithId(buyer, principalUsd, bonusUsd, entry.id, true)
      : { enabled: antseedFundingVault.enabled, buyer, amountUsd: "0" };
    if (!shouldCredit) {
      logInfo("funding.skipped.zero-amount", {
        entryId: entry.id,
        source: entry.source,
        account: redactAddress(entry.account),
        buyer: redactAddress(buyer)
      });
    } else if (!bridge.enabled) {
      logWarn("funding.bridge.disabled", {
        entryId: entry.id,
        source: entry.source,
        buyer: redactAddress(buyer)
      });
    }
    if (bridge.skipped) {
      const updated = await store.markFundingResult(entry, {
        funded: false,
        txHash: previousFundingTxHash,
        error: bridge.skipReason
      });
      logInfo("funding.skipped", {
        entryId: entry.id,
        source: entry.source,
        buyer: redactAddress(buyer),
        reason: bridge.skipReason
      });
      return { ...updated, bridge };
    }
    const fundingTxHash = bridge.txHash ?? previousFundingTxHash;
    const updated = await store.markFundingResult(entry, {
      funded: true,
      txHash: fundingTxHash,
      error: undefined,
      credited: shouldCredit
    });
    logInfo("funding.success", {
      entryId: entry.id,
      source: entry.source,
      buyer: redactAddress(buyer),
      txHash: redactHash(fundingTxHash),
      bridgeEnabled: bridge.enabled,
      reconciled: bridge.alreadyFunded === true
    });
    return { ...updated, bridge };
  } catch (error) {
    await reportFailure?.({ operation: "funding.deposit", chain: "base", error, entryId: entry.id, buyer });
    const message = errorMessage(error);
    logError("funding.failed", {
      entryId: entry.id,
      source: entry.source,
      account: redactAddress(entry.account),
      buyer: redactAddress(buyer),
      message
    });
    let updated: GdCreditEntry;
    const fundingTxHash = error && typeof error === "object" && "fundingTxHash" in error ? String(error.fundingTxHash) : undefined;
    try {
      updated = await store.markFundingResult(entry, { funded: false, txHash: fundingTxHash ?? previousFundingTxHash, error: message });
    } catch (persistenceError) {
      logError("funding.failure-persistence.failed", { entryId: entry.id, message: errorMessage(persistenceError) });
      throw error;
    }
    return {
      ...updated,
      depositId: entry.id,
      bridge: {
        enabled: antseedFundingVault.enabled,
        buyer,
        amountUsd: entry.totalCreditUsd,
        error: message
      }
    };
  }
}
