export type CreditBonusInput = {
  principalMicroUsd: bigint;
  monthlyStreamCapMicroUsd: bigint;
  streamingBonusUsedMicroUsd: bigint;
};

export type CreditBonusResult = {
  principalMicroUsd: bigint;
  regularBonusMicroUsd: bigint;
  streamingBonusMicroUsd: bigint;
  totalCreditMicroUsd: bigint;
  streamingBonusPrincipalAppliedMicroUsd: bigint;
};

const REGULAR_BONUS_BPS = 1_000n; // +10%
const STREAMING_EXTRA_BONUS_BPS = 1_000n; // extra +10%, total +20% on capped principal
const BPS = 10_000n;

export function calculateCreditWithBonus(input: CreditBonusInput): CreditBonusResult {
  const remainingStreamingCap = input.monthlyStreamCapMicroUsd > input.streamingBonusUsedMicroUsd
    ? input.monthlyStreamCapMicroUsd - input.streamingBonusUsedMicroUsd
    : 0n;
  const streamingBonusPrincipal = min(input.principalMicroUsd, remainingStreamingCap);
  const regularBonus = (input.principalMicroUsd * REGULAR_BONUS_BPS) / BPS;
  const streamingBonus = (streamingBonusPrincipal * STREAMING_EXTRA_BONUS_BPS) / BPS;

  return {
    principalMicroUsd: input.principalMicroUsd,
    regularBonusMicroUsd: regularBonus,
    streamingBonusMicroUsd: streamingBonus,
    totalCreditMicroUsd: input.principalMicroUsd + regularBonus + streamingBonus,
    streamingBonusPrincipalAppliedMicroUsd: streamingBonusPrincipal
  };
}

export function gdWeiToMicroUsd(gdAmountWei: bigint, gdMicroUsdPerToken: bigint): bigint {
  return (gdAmountWei * gdMicroUsdPerToken) / 1_000_000_000_000_000_000n;
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
