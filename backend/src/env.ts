export interface Env {
  ANTSEED_KV: KVNamespace;

  ANTSEED_FUNDING_RPC_URL?: string;
  ANTSEED_FUNDING_VAULT_ADDRESS?: string;
  ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY?: string;

  GD_MICRO_USD_PER_TOKEN?: string;
  CELO_RPC_URL?: string;
  CELO_VAULT_ADDRESS?: string;
  CELO_GOODID_ADDRESS?: string;
  CELO_EVENTS_API_KEY?: string;
}

export type RuntimeConfig = {
  ANTSEED_FUNDING_RPC_URL?: string;
  ANTSEED_FUNDING_VAULT_ADDRESS?: string;
  ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY?: string;
  GD_MICRO_USD_PER_TOKEN: bigint;
  CELO_RPC_URL?: string;
  CELO_VAULT_ADDRESS?: string;
  CELO_GOODID_ADDRESS?: string;
  CELO_EVENTS_API_KEY?: string;
};

export function configFromEnv(env: Env): RuntimeConfig {
  return {
    ANTSEED_FUNDING_RPC_URL: env.ANTSEED_FUNDING_RPC_URL,
    ANTSEED_FUNDING_VAULT_ADDRESS: env.ANTSEED_FUNDING_VAULT_ADDRESS,
    ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY: env.ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY,
    GD_MICRO_USD_PER_TOKEN: bigintEnv(env.GD_MICRO_USD_PER_TOKEN, 1_000_000n),
    CELO_RPC_URL: env.CELO_RPC_URL,
    CELO_VAULT_ADDRESS: env.CELO_VAULT_ADDRESS,
    CELO_GOODID_ADDRESS: env.CELO_GOODID_ADDRESS,
    CELO_EVENTS_API_KEY: env.CELO_EVENTS_API_KEY
  };
}

function bigintEnv(value: string | undefined, fallback: bigint): bigint {
  if (!value) return fallback;
  return BigInt(value);
}
