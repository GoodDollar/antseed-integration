import { GdCreditEntry } from "./types";

export type CreditBonusInput = {
  principalMicroUsd: bigint;
  monthlyStreamCapMicroUsd: bigint;
  streamingBonusUsedMicroUsd: bigint;
};

export type CreditBonusResult = {
  principalMicroUsd: bigint;
  bonusMicroUsd: bigint;
  totalCreditMicroUsd: bigint;
};

const REGULAR_BONUS_BPS = 1_000n; // +10%
const STREAMING_BONUS_BPS = 2_000n; // +20% for streaming sources
const BPS = 10_000n;
const WEI_PER_GD = 1_000_000_000_000_000_000n;

export function calculateCreditWithBonus(gdAmountWei: bigint, source: GdCreditEntry["source"], isVerified: boolean, gdPrice: bigint): CreditBonusResult {
  
  const principalMicroUsd = gdWeiToMicroUsd(gdAmountWei, gdPrice);
  let bonusMicroUsd = source.startsWith("stream") ? (principalMicroUsd * STREAMING_BONUS_BPS) / BPS : (principalMicroUsd * REGULAR_BONUS_BPS) / BPS;
  if(!isVerified) {
    bonusMicroUsd = 0n;
  }

  return {
    principalMicroUsd,
    bonusMicroUsd,
    totalCreditMicroUsd: principalMicroUsd + bonusMicroUsd,
  };
}

export function gdWeiToMicroUsd(gdAmountWei: bigint, gdMicroUsdPerToken: bigint): bigint {
  return (gdAmountWei * gdMicroUsdPerToken) / WEI_PER_GD;
}

export function microUsdToGdWei(microUsd: bigint, gdMicroUsdPerToken: bigint): bigint {
  if (gdMicroUsdPerToken <= 0n) return 0n;
  return (microUsd * WEI_PER_GD) / gdMicroUsdPerToken;
}

export function monthlyStreamMicroUsd(flowRateWeiPerSecond: bigint, gdMicroUsdPerToken: bigint): bigint {
  return gdWeiToMicroUsd(flowRateWeiPerSecond * BigInt(30 * 24 * 60 * 60), gdMicroUsdPerToken);
}

export function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

