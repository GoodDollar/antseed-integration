import test from "node:test";
import assert from "node:assert/strict";
import { calculateCreditWithBonus, gdWeiToMicroUsd, monthlyStreamMicroUsd } from "../src/credit-bonus.js";

test("regular G$ deposit gets 10% USDC credit bonus", () => {
  const result = calculateCreditWithBonus({
    principalMicroUsd: 10_000_000n,
    monthlyStreamCapMicroUsd: 0n,
    streamingBonusUsedMicroUsd: 0n
  });

  assert.equal(result.regularBonusMicroUsd, 1_000_000n);
  assert.equal(result.streamingBonusMicroUsd, 0n);
  assert.equal(result.totalCreditMicroUsd, 11_000_000n);
});

test("streaming users get extra 10% up to monthly stream cap", () => {
  const result = calculateCreditWithBonus({
    principalMicroUsd: 10_000_000n,
    monthlyStreamCapMicroUsd: 1_000_000n,
    streamingBonusUsedMicroUsd: 0n
  });

  assert.equal(result.regularBonusMicroUsd, 1_000_000n);
  assert.equal(result.streamingBonusMicroUsd, 100_000n);
  assert.equal(result.totalCreditMicroUsd, 11_100_000n);
});

test("streaming cap can be fully consumed in a month", () => {
  const result = calculateCreditWithBonus({
    principalMicroUsd: 10_000_000n,
    monthlyStreamCapMicroUsd: 1_000_000n,
    streamingBonusUsedMicroUsd: 1_000_000n
  });

  assert.equal(result.streamingBonusMicroUsd, 0n);
  assert.equal(result.totalCreditMicroUsd, 11_000_000n);
});

test("$1/month stream can receive $1.20 credits on $1 streamed principal", () => {
  const result = calculateCreditWithBonus({
    principalMicroUsd: 1_000_000n,
    monthlyStreamCapMicroUsd: 1_000_000n,
    streamingBonusUsedMicroUsd: 0n
  });

  assert.equal(result.totalCreditMicroUsd, 1_200_000n);
});

test("G$ wei converts to micro-USD and monthly stream cap", () => {
  assert.equal(gdWeiToMicroUsd(1_000_000_000_000_000_000n, 1_000_000n), 1_000_000n);
  const flowRate = 1_000_000_000_000_000_000n / BigInt(30 * 24 * 60 * 60);
  assert.equal(monthlyStreamMicroUsd(flowRate, 1_000_000n) > 999_000n, true);
});
