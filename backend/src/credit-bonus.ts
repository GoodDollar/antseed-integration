import { GdCreditEntry } from "./types";

export type CreditBonusInput = {
  principalUsd: bigint;
  monthlyStreamCapUsd: bigint;
  streamingBonusUsedUsd: bigint;
};

export type CreditBonusResult = {
  principalUsd: bigint;
  bonusUsd: bigint;
  totalCreditUsd: bigint;
};

const REGULAR_BONUS_BPS = 1_000n; // +10%
const STREAMING_BONUS_BPS = 2_000n; // +20% for streaming sources
const BPS = 10_000n;


export function calculateCreditWithBonus(gdAmountWei: bigint, source: GdCreditEntry["source"], isVerified: boolean, gdPrice: number): CreditBonusResult {
  
  const principalUsd = gdWeiToUsd(gdAmountWei, gdPrice);
  let bonusUsd = source.startsWith("stream") ? (principalUsd * STREAMING_BONUS_BPS) / BPS : (principalUsd * REGULAR_BONUS_BPS) / BPS;
  if(!isVerified) {
    bonusUsd = 0n;
  }

  return {
    principalUsd,
    bonusUsd,
    totalCreditUsd: principalUsd + bonusUsd,
  };
}

export function gdWeiToUsd(gdAmountWei: bigint, gdPrice: number): bigint {
  const usdPerToken = BigInt(Math.round(gdPrice * 1e6));
  return (gdAmountWei * usdPerToken) / 1_000_000_000_000_000_000n;
}

export function usdToGdWei(usdAmount: bigint, gdPrice: number): bigint {
  const usdPerToken = BigInt(Math.round(gdPrice * 1e6));
  if (usdPerToken <= 0n) return 0n;
  return (usdAmount * 1_000_000_000_000_000_000n) / usdPerToken;
}

export function monthlyStreamUsd(flowRateWeiPerSecond: bigint, gdPrice: number): bigint {
  return gdWeiToUsd(flowRateWeiPerSecond * BigInt(30 * 24 * 60 * 60), gdPrice);
}

export function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

