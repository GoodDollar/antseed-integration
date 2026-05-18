import test from "node:test";
import assert from "node:assert/strict";
import { actualCostMicroUsd, estimateMaxCostMicroUsd, estimateTokens } from "../src/pricing.js";

const cfg = {
  PRICE_MICRO_USD_PER_1K_INPUT_TOKENS: 500n,
  PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS: 1500n,
  DEFAULT_MAX_OUTPUT_TOKENS: 1000,
  MIN_RESERVE_MICRO_USD: 1000n
};

test("estimates tokens deterministically", () => {
  const tokens = estimateTokens([{ role: "user", content: "hello world" }]);
  assert.equal(tokens > 0, true);
});

test("reserve estimate respects minimum", () => {
  const cost = estimateMaxCostMicroUsd(cfg, [{ role: "user", content: "hi" }], 1);
  assert.equal(cost, 1000n);
});

test("actual cost uses input and output prices", () => {
  const cost = actualCostMicroUsd(cfg, 2000, 1000);
  assert.equal(cost, 2500n);
});
