import { gdWeiToMicroUsd, microUsdToGdWei } from "./credit-bonus.js";

export type GdToCreditQuote = {
  direction: "gd-to-credit";
  gdAmountWei: string;
  gdMicroUsdPerToken: string;
  creditMicroUsd: string;
};

export type CreditToGdQuote = {
  direction: "credit-to-gd";
  creditMicroUsd: string;
  gdMicroUsdPerToken: string;
  gdAmountWei: string;
};

export function quoteGdToCredit(input: {
  gdAmountWei: bigint;
  gdMicroUsdPerToken: bigint;
}): GdToCreditQuote {
  const creditMicroUsd = gdWeiToMicroUsd(input.gdAmountWei, input.gdMicroUsdPerToken);
  return {
    direction: "gd-to-credit",
    gdAmountWei: input.gdAmountWei.toString(),
    gdMicroUsdPerToken: input.gdMicroUsdPerToken.toString(),
    creditMicroUsd: creditMicroUsd.toString()
  };
}

export function quoteCreditToGd(input: {
  creditMicroUsd: bigint;
  gdMicroUsdPerToken: bigint;
}): CreditToGdQuote {
  const gdAmountWei = microUsdToGdWei(input.creditMicroUsd, input.gdMicroUsdPerToken);
  return {
    direction: "credit-to-gd",
    creditMicroUsd: input.creditMicroUsd.toString(),
    gdMicroUsdPerToken: input.gdMicroUsdPerToken.toString(),
    gdAmountWei: gdAmountWei.toString()
  };
}
