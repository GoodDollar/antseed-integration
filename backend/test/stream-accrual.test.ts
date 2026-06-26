import test from "node:test";
import assert from "node:assert/strict";
import {
  STREAM_ACCRUAL_MAX_SECONDS,
  streamAccrualElapsedSeconds,
  streamGdAmountWei
} from "../src/stream-accrual.js";

test("streamAccrualElapsedSeconds caps at one day", () => {
  const now = 1_000_000n;
  const updatedTwoDaysAgo = now - BigInt(STREAM_ACCRUAL_MAX_SECONDS * 2);
  assert.equal(
    streamAccrualElapsedSeconds(updatedTwoDaysAgo, STREAM_ACCRUAL_MAX_SECONDS, now),
    BigInt(STREAM_ACCRUAL_MAX_SECONDS)
  );
});

test("streamAccrualElapsedSeconds uses time since updatedAt when under one day", () => {
  const now = 10_000n;
  const updatedAt = 7_000n;
  assert.equal(streamAccrualElapsedSeconds(updatedAt, STREAM_ACCRUAL_MAX_SECONDS, now), 3_000n);
});

test("streamGdAmountWei multiplies flow rate by elapsed seconds", () => {
  const amount = streamGdAmountWei(100n, 0n, STREAM_ACCRUAL_MAX_SECONDS, 3_600n);
  assert.equal(amount, 100n * 3_600n);
});
