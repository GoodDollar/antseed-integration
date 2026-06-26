export const STREAM_ACCRUAL_MAX_SECONDS = 86_400;

export function streamAccrualElapsedSeconds(
  updatedAtTimestamp: bigint | string,
  maxElapsedSeconds = STREAM_ACCRUAL_MAX_SECONDS,
  nowSeconds = BigInt(Math.floor(Date.now() / 1000))
): bigint {
  const updatedAt = BigInt(updatedAtTimestamp);
  const sinceUpdate = nowSeconds > updatedAt ? nowSeconds - updatedAt : 0n;
  const maxElapsed = BigInt(maxElapsedSeconds);
  return sinceUpdate < maxElapsed ? sinceUpdate : maxElapsed;
}

export function streamGdAmountWei(
  flowRateWeiPerSecond: bigint,
  updatedAtTimestamp: bigint | string,
  maxElapsedSeconds = STREAM_ACCRUAL_MAX_SECONDS,
  nowSeconds = BigInt(Math.floor(Date.now() / 1000))
): bigint {
  const elapsed = streamAccrualElapsedSeconds(updatedAtTimestamp, maxElapsedSeconds, nowSeconds);
  if (elapsed <= 0n || flowRateWeiPerSecond <= 0n) return 0n;
  return flowRateWeiPerSecond * elapsed;
}
