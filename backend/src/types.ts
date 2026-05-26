export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type CreditReservation = {
  requestId: string;
  account: string;
  rootAccount?: string;
  maxCostMicroUsd: string;
  status: "reserved" | "settled" | "released";
  actualCostMicroUsd?: string;
  providerReceiptHash?: string;
  vaultReserveTxHash?: string;
  vaultSettleTxHash?: string;
  vaultReleaseTxHash?: string;
  createdAt: string;
  updatedAt: string;
};

export type UserCreditProfile = {
  account: string;
  rootAccount: string;
  createdAt: string;
  updatedAt: string;
  totalRequests: number;
  totalReservedMicroUsd: string;
  totalSettledMicroUsd: string;
  creditBalanceMicroUsd: string;
  reservedCreditMicroUsd: string;
  totalGdDepositedWei: string;
  totalGdPrincipalMicroUsd: string;
  totalGdCreditsIssuedMicroUsd: string;
  totalRegularBonusMicroUsd: string;
  totalStreamingBonusMicroUsd: string;
  streamFlowRateWeiPerSecond: string;
  streamMonthlyMicroUsd: string;
  lastRequestId?: string;
};

export type GdCreditEntry = {
  id: string;
  account: string;
  rootAccount: string;
  source: "erc677" | "erc777" | "erc20" | "stream" | "manual";
  gdAmountWei: string;
  principalMicroUsd: string;
  regularBonusMicroUsd: string;
  streamingBonusMicroUsd: string;
  totalCreditMicroUsd: string;
  streamingBonusPrincipalAppliedMicroUsd: string;
  month: string;
  txHash?: string;
  logIndex?: number;
  createdAt: string;
};

export type StreamState = {
  account: string;
  rootAccount: string;
  flowRateWeiPerSecond: string;
  monthlyGdAmountWei: string;
  monthlyMicroUsd: string;
  txHash?: string;
  logIndex?: number;
  updatedAt: string;
};
