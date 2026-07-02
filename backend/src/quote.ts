import { gdWeiToUsd, usdToGdWei } from "./credit-bonus.js";

export type GdToCreditQuote = {
  direction: "gd-to-credit";
  gdAmountWei: string;
  gdPrice: string;
  creditUsd: string;
};

export type CreditToGdQuote = {
  direction: "credit-to-gd";
  creditUsd: string;
  gdPrice: string;
  gdAmountWei: string;
};

export function quoteGdToCredit(input: {
  gdAmountWei: bigint;
  gdPrice: number;
}): GdToCreditQuote {
  const creditUsd = gdWeiToUsd(input.gdAmountWei, input.gdPrice);
  return {
    direction: "gd-to-credit",
    gdAmountWei: input.gdAmountWei.toString(),
    gdPrice: input.gdPrice.toString(),
    creditUsd: creditUsd.toString()
  };
}

export function quoteCreditToGd(input: {
  creditUsd: bigint;
  gdPrice: number;
}): CreditToGdQuote {
  const gdAmountWei = usdToGdWei(input.creditUsd, input.gdPrice);
  return {
    direction: "credit-to-gd",
    creditUsd: input.creditUsd.toString(),
    gdPrice: input.gdPrice.toString(),
    gdAmountWei: gdAmountWei.toString()
  };
}
