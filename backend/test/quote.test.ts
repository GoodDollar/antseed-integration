import test from "node:test";
import assert from "node:assert/strict";
import { quoteCreditToGd, quoteGdToCredit } from "../src/quote.js";

const GD_PRICE = 1_000_000n;
const ONE_GD = 1_000_000_000_000_000_000n;

test("quoteGdToCredit converts G$ wei to credit via oracle price only", () => {
  const quote = quoteGdToCredit({
    gdAmountWei: 10n * ONE_GD,
    gdMicroUsdPerToken: GD_PRICE
  });

  assert.equal(quote.creditMicroUsd, "10000000");
});

test("quoteCreditToGd converts credit micro-USD to G$ wei", () => {
  const quote = quoteCreditToGd({
    creditMicroUsd: 1_000_000n,
    gdMicroUsdPerToken: GD_PRICE
  });

  assert.equal(quote.gdAmountWei, ONE_GD.toString());
});

test("quoteGdToCredit and quoteCreditToGd round-trip", () => {
  const gdToCredit = quoteGdToCredit({
    gdAmountWei: ONE_GD,
    gdMicroUsdPerToken: GD_PRICE
  });
  const creditToGd = quoteCreditToGd({
    creditMicroUsd: BigInt(gdToCredit.creditMicroUsd),
    gdMicroUsdPerToken: GD_PRICE
  });
  assert.equal(creditToGd.gdAmountWei, ONE_GD.toString());
});
