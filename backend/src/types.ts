export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type ChatCompletionRequest = {
  account: string;
  model?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
};

export type CreditReservation = {
  requestId: string;
  account: string;
  maxCostMicroUsd: bigint;
  status: "reserved" | "settled" | "released";
  actualCostMicroUsd?: bigint;
  providerReceiptHash?: string;
  createdAt: string;
  updatedAt: string;
};

export type AntSeedChatCompletion = {
  id?: string;
  model?: string;
  choices?: unknown[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
};
