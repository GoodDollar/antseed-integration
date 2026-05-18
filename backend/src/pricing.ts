import { Config } from "./config.js";
import { ChatMessage } from "./types.js";

export function estimateTokens(messages: ChatMessage[]): number {
  // Cheap deterministic approximation: ~4 chars/token plus small role overhead.
  const chars = messages.reduce((sum, msg) => sum + msg.role.length + msg.content.length + 8, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

export function estimateMaxCostMicroUsd(
  cfg: Pick<Config,
    | "PRICE_MICRO_USD_PER_1K_INPUT_TOKENS"
    | "PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS"
    | "DEFAULT_MAX_OUTPUT_TOKENS"
    | "MIN_RESERVE_MICRO_USD"
  >,
  messages: ChatMessage[],
  maxOutputTokens?: number
): bigint {
  const inputTokens = BigInt(estimateTokens(messages));
  const outputTokens = BigInt(maxOutputTokens ?? cfg.DEFAULT_MAX_OUTPUT_TOKENS);
  const inputCost = (inputTokens * cfg.PRICE_MICRO_USD_PER_1K_INPUT_TOKENS + 999n) / 1000n;
  const outputCost = (outputTokens * cfg.PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS + 999n) / 1000n;
  const total = inputCost + outputCost;
  return total > cfg.MIN_RESERVE_MICRO_USD ? total : cfg.MIN_RESERVE_MICRO_USD;
}

export function actualCostMicroUsd(
  cfg: Pick<Config, "PRICE_MICRO_USD_PER_1K_INPUT_TOKENS" | "PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS" | "MIN_RESERVE_MICRO_USD">,
  promptTokens = 0,
  completionTokens = 0
): bigint {
  const input = (BigInt(promptTokens) * cfg.PRICE_MICRO_USD_PER_1K_INPUT_TOKENS + 999n) / 1000n;
  const output = (BigInt(completionTokens) * cfg.PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS + 999n) / 1000n;
  const total = input + output;
  return total > 0n ? total : cfg.MIN_RESERVE_MICRO_USD;
}
