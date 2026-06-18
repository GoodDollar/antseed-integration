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
  totalGdDepositedWei: string;
  totalPrincipalMicroUsd: string;
  totalBonusMicroUsd: string;
  totalGDStreamedWei: string;
  totalOutstandingFundingMicroUsd: string;
  streamFlowRateWeiPerSecond: string;
  lastStreamCreditAt: string;
};

export type GdCreditEntry = {
  id: string;
  account: string;
  rootAccount: string;
  source: "deposit" | "streamUpdate" | "streamRequest" | "streamCron";
  gdAmountWei: string;
  principalMicroUsd: string;
  bonusMicroUsd: string;
  totalCreditMicroUsd: string;
  txHash?: string;
  logIndex?: number;
  fundingStatus: "pending" | "funded" | "failed";
  fundingTxHash?: string;
  fundingError?: string;
  createdAt: string;
  streamUpdateMonth: string;
  /** AntSeed buyer account address to which credits are funded. */
  buyerAddress?: string;
};

export type StreamState = {
  account: string;
  rootAccount: string;
  flowRateWeiPerSecond: string;
  monthlyGdAmountWei: string;
  monthlyMicroUsd: string;
  active: boolean;
  lastBonusPaidAt: string;
  txHash?: string;
  logIndex?: number;
  updatedAt: string;
};
