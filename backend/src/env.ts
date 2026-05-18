export interface Env {
  ANTSEED_KV: KVNamespace;

  ANTSEED_BASE_URL: string;
  ANTSEED_MODEL?: string;
  ANTSEED_PIN_PEER?: string;
  ANTSEED_PIN_SERVICE?: string;
  ANTSEED_TIMEOUT_MS?: string;

  PRICE_MICRO_USD_PER_1K_INPUT_TOKENS?: string;
  PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS?: string;
  DEFAULT_MAX_OUTPUT_TOKENS?: string;
  MIN_RESERVE_MICRO_USD?: string;
  CREDIT_TOKEN_DECIMALS?: string;
  GD_MICRO_USD_PER_TOKEN?: string;
  CELO_RPC_URL?: string;
  CELO_VAULT_ADDRESS?: string;
  CELO_GOODID_ADDRESS?: string;

  RPC_URL?: string;
  VAULT_ADDRESS?: string;
  OPERATOR_PRIVATE_KEY?: string;
}

export type RuntimeConfig = {
  ANTSEED_BASE_URL: string;
  ANTSEED_MODEL: string;
  ANTSEED_PIN_PEER?: string;
  ANTSEED_PIN_SERVICE?: string;
  ANTSEED_TIMEOUT_MS: number;
  PRICE_MICRO_USD_PER_1K_INPUT_TOKENS: bigint;
  PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS: bigint;
  DEFAULT_MAX_OUTPUT_TOKENS: number;
  MIN_RESERVE_MICRO_USD: bigint;
  CREDIT_TOKEN_DECIMALS: number;
  GD_MICRO_USD_PER_TOKEN: bigint;
  CELO_RPC_URL?: string;
  CELO_VAULT_ADDRESS?: string;
  CELO_GOODID_ADDRESS?: string;
  RPC_URL?: string;
  VAULT_ADDRESS?: string;
  OPERATOR_PRIVATE_KEY?: string;
};

export function configFromEnv(env: Env): RuntimeConfig {
  return {
    ANTSEED_BASE_URL: env.ANTSEED_BASE_URL || "http://127.0.0.1:8377",
    ANTSEED_MODEL: env.ANTSEED_MODEL || "qwen3-235b-instruct",
    ANTSEED_PIN_PEER: env.ANTSEED_PIN_PEER,
    ANTSEED_PIN_SERVICE: env.ANTSEED_PIN_SERVICE,
    ANTSEED_TIMEOUT_MS: numberEnv(env.ANTSEED_TIMEOUT_MS, 120_000),
    PRICE_MICRO_USD_PER_1K_INPUT_TOKENS: bigintEnv(env.PRICE_MICRO_USD_PER_1K_INPUT_TOKENS, 500n),
    PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS: bigintEnv(env.PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS, 1_500n),
    DEFAULT_MAX_OUTPUT_TOKENS: numberEnv(env.DEFAULT_MAX_OUTPUT_TOKENS, 1024),
    MIN_RESERVE_MICRO_USD: bigintEnv(env.MIN_RESERVE_MICRO_USD, 1_000n),
    CREDIT_TOKEN_DECIMALS: numberEnv(env.CREDIT_TOKEN_DECIMALS, 6),
    GD_MICRO_USD_PER_TOKEN: bigintEnv(env.GD_MICRO_USD_PER_TOKEN, 1_000_000n),
    CELO_RPC_URL: env.CELO_RPC_URL,
    CELO_VAULT_ADDRESS: env.CELO_VAULT_ADDRESS,
    CELO_GOODID_ADDRESS: env.CELO_GOODID_ADDRESS,
    RPC_URL: env.RPC_URL,
    VAULT_ADDRESS: env.VAULT_ADDRESS,
    OPERATOR_PRIVATE_KEY: env.OPERATOR_PRIVATE_KEY
  };
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid numeric env value: ${value}`);
  return parsed;
}

function bigintEnv(value: string | undefined, fallback: bigint): bigint {
  if (!value) return fallback;
  return BigInt(value);
}
