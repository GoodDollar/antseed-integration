import test from "node:test";
import assert from "node:assert/strict";
import { calculateCreditWithBonus, gdWeiToUsd, monthlyStreamUsd, monthKey } from "../src/credit-bonus.js";

const GD_PRICE = 1.0; // 1 G$ = $1.00 cUSD

test("regular G$ deposit gets 10% USDC credit bonus for verified accounts", () => {
  const result = calculateCreditWithBonus(
    10_000_000_000_000_000_000n, // 10 G$
    "deposit",
    true,
    GD_PRICE
  );

  assert.equal(result.principalUsd, 10_000_000n);
  assert.equal(result.bonusUsd, 1_000_000n); // 10%
  assert.equal(result.totalCreditUsd, 11_000_000n);
});

test("streaming sources get 20% bonus for verified accounts", () => {
  const result = calculateCreditWithBonus(
    1_000_000_000_000_000_000n, // 1 G$
    "streamRequest",
    true,
    GD_PRICE
  );

  assert.equal(result.principalUsd, 1_000_000n);
  assert.equal(result.bonusUsd, 200_000n); // 20%
  assert.equal(result.totalCreditUsd, 1_200_000n);
});

test("streamCron source also gets 20% bonus", () => {
  const result = calculateCreditWithBonus(
    1_000_000_000_000_000_000n,
    "streamCron",
    true,
    GD_PRICE
  );

  assert.equal(result.bonusUsd, 200_000n);
});

test("unverified accounts get no bonus", () => {
  const result = calculateCreditWithBonus(
    10_000_000_000_000_000_000n,
    "deposit",
    false,
    GD_PRICE
  );

  assert.equal(result.principalUsd, 10_000_000n);
  assert.equal(result.bonusUsd, 0n);
  assert.equal(result.totalCreditUsd, 10_000_000n);
});

test("G$ wei converts to micro-USD and monthly stream cap", () => {
  assert.equal(gdWeiToUsd(1_000_000_000_000_000_000n, 1.0), 1_000_000n);
  const flowRate = 1_000_000_000_000_000_000n / BigInt(30 * 24 * 60 * 60);
  assert.equal(monthlyStreamUsd(flowRate, 1.0) > 999_000n, true);
});

test("monthKey returns YYYY-MM format", () => {
  assert.equal(monthKey(new Date("2026-05-28")), "2026-05");
  assert.equal(monthKey(new Date("2026-12-01")), "2026-12");
});
