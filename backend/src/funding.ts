import { AntSeedFundingVaultClient } from "./antseed-funding-vault.js";
import { KVCreditStore } from "./kv-credit-store.js";
import { GdCreditEntry } from "./types.js";
import { errorMessage, logError, logInfo, logWarn, redactAddress, redactHash } from "./logging.js";

export async function fundCredit(
  entry: GdCreditEntry,
  store: KVCreditStore,
  antseedFundingVault: AntSeedFundingVaultClient
): Promise<{ [key: string]: unknown }> {
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
      ? await antseedFundingVault.depositForBuyerWithId(buyer, principalUsd, bonusUsd, entry.id)
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
    const updated = await store.markFundingResult(entry, {
      funded: true,
      txHash: bridge.txHash,
      error: undefined,
      credited: shouldCredit
    });
    logInfo("funding.success", {
      entryId: entry.id,
      source: entry.source,
      buyer: redactAddress(buyer),
      txHash: redactHash(bridge.txHash),
      bridgeEnabled: bridge.enabled
    });
    return { ...updated, bridge };
  } catch (error) {
    const message = errorMessage(error);
    logError("funding.failed", {
      entryId: entry.id,
      source: entry.source,
      account: redactAddress(entry.account),
      buyer: redactAddress(buyer),
      message
    });
    const updated = await store.markFundingResult(entry, {
      funded: false,
      error: message
    });
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
