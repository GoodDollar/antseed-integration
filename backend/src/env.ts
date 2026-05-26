export interface Env {
  ANTSEED_KV: KVNamespace;

  ANTSEED_FUNDING_RPC_URL?: string;
  ANTSEED_FUNDING_VAULT_ADDRESS?: string;
  ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY?: string;

  PRICE_MICRO_USD_PER_1K_INPUT_TOKENS?: string;
  PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS?: string;
  DEFAULT_MAX_OUTPUT_TOKENS?: string;
  MIN_RESERVE_MICRO_USD?: string;
  CREDIT_TOKEN_DECIMALS?: string;
  GD_MICRO_USD_PER_TOKEN?: string;
  CELO_RPC_URL?: string;
  CELO_VAULT_ADDRESS?: string;
  CELO_GOODID_ADDRESS?: string;
  AUTH_NONCE_TTL_SECONDS?: string;
  API_KEY_TTL_SECONDS?: string;
  ALLOW_UNVERIFIED_ACCOUNT_SELECTOR?: string;

  RPC_URL?: string;
  VAULT_ADDRESS?: string;
  OPERATOR_PRIVATE_KEY?: string;
}

export type RuntimeConfig = {
  ANTSEED_FUNDING_RPC_URL?: string;
  ANTSEED_FUNDING_VAULT_ADDRESS?: string;
  ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY?: string;
  PRICE_MICRO_USD_PER_1K_INPUT_TOKENS: bigint;
  PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS: bigint;
  DEFAULT_MAX_OUTPUT_TOKENS: number;
  MIN_RESERVE_MICRO_USD: bigint;
  CREDIT_TOKEN_DECIMALS: number;
  GD_MICRO_USD_PER_TOKEN: bigint;
  CELO_RPC_URL?: string;
  CELO_VAULT_ADDRESS?: string;
  CELO_GOODID_ADDRESS?: string;
  AUTH_NONCE_TTL_SECONDS: number;
  API_KEY_TTL_SECONDS?: number;
  ALLOW_UNVERIFIED_ACCOUNT_SELECTOR: boolean;
  RPC_URL?: string;
  VAULT_ADDRESS?: string;
  OPERATOR_PRIVATE_KEY?: string;
};

export function configFromEnv(env: Env): RuntimeConfig {
  return {
    ANTSEED_FUNDING_RPC_URL: env.ANTSEED_FUNDING_RPC_URL,
    ANTSEED_FUNDING_VAULT_ADDRESS: env.ANTSEED_FUNDING_VAULT_ADDRESS,
    ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY: env.ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY,
    PRICE_MICRO_USD_PER_1K_INPUT_TOKENS: bigintEnv(env.PRICE_MICRO_USD_PER_1K_INPUT_TOKENS, 500n),
    PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS: bigintEnv(env.PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS, 1_500n),
    DEFAULT_MAX_OUTPUT_TOKENS: numberEnv(env.DEFAULT_MAX_OUTPUT_TOKENS, 1024),
    MIN_RESERVE_MICRO_USD: bigintEnv(env.MIN_RESERVE_MICRO_USD, 1_000n),
    CREDIT_TOKEN_DECIMALS: numberEnv(env.CREDIT_TOKEN_DECIMALS, 6),
    GD_MICRO_USD_PER_TOKEN: bigintEnv(env.GD_MICRO_USD_PER_TOKEN, 1_000_000n),
    CELO_RPC_URL: env.CELO_RPC_URL,
    CELO_VAULT_ADDRESS: env.CELO_VAULT_ADDRESS,
    CELO_GOODID_ADDRESS: env.CELO_GOODID_ADDRESS,
    AUTH_NONCE_TTL_SECONDS: numberEnv(env.AUTH_NONCE_TTL_SECONDS, 600),
    API_KEY_TTL_SECONDS: optionalNumberEnv(env.API_KEY_TTL_SECONDS),
    ALLOW_UNVERIFIED_ACCOUNT_SELECTOR: booleanEnv(env.ALLOW_UNVERIFIED_ACCOUNT_SELECTOR, false),
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

function optionalNumberEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return numberEnv(value, 0);
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function bigintEnv(value: string | undefined, fallback: bigint): bigint {
  if (!value) return fallback;
  return BigInt(value);
}
