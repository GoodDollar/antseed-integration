import assert from "node:assert/strict";
import test from "node:test";
import { StreamPeriod, earliestUnsettledStop, latestBuyerAddress, liveFlowRate, streamOwedWei } from "../src/stream-periods.js";

const period = (flowRate: bigint, startedAt: number, stoppedAt?: number, buyerAddress?: string): StreamPeriod => ({
  id: `p-${startedAt}`,
  account: "0xabc",
  flowRateWeiPerSecond: flowRate,
  startedAt,
  stoppedAt,
  buyerAddress
});

test("streamOwedWei prices each period's overlap with the uncredited window", () => {
  const periods = [period(10n, 0, 100), period(5n, 100)];
  // Window (50, 200]: 50s at 10 + 100s at 5.
  assert.equal(streamOwedWei(periods, 50, 200), 10n * 50n + 5n * 100n);
});

test("streamOwedWei earns nothing in a gap between periods", () => {
  const periods = [period(10n, 0, 100), period(10n, 500)];
  assert.equal(streamOwedWei(periods, 50, 600), 10n * 50n + 10n * 100n);
});

test("streamOwedWei credits a first-time account from the stream's start, never past asOf", () => {
  assert.equal(streamOwedWei([period(7n, 1000)], 0, 1100), 700n);
  assert.equal(streamOwedWei([period(7n, 1000)], 1200, 1100), 0n, "a clock ahead of the head owes nothing");
});

test("liveFlowRate, latestBuyerAddress and earliestUnsettledStop", () => {
  const periods = [period(10n, 0, 100, "0xold"), period(3n, 200, 300, "0xmid"), period(4n, 400, undefined, "0xnew")];
  assert.equal(liveFlowRate(periods), 4n);
  assert.equal(latestBuyerAddress(periods), "0xnew");
  assert.equal(earliestUnsettledStop(periods, 50), 100);
  assert.equal(earliestUnsettledStop(periods, 100), 300);
  assert.equal(earliestUnsettledStop(periods, 300), undefined);
});
