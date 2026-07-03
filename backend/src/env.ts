import { parseEther, parseUnits } from "ethers";

export interface Env {
  ANTSEED_KV: KVNamespace;

  ANTSEED_FUNDING_RPC_URL?: string;
  ANTSEED_FUNDING_VAULT_ADDRESS?: string;
  ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY?: string;
  SLACK_WEBHOOK_URL?: string;

  GD_CUSD_PRICE?: string;
  CELO_RPC_URL?: string;
  CELO_VAULT_ADDRESS?: string;
  CELO_GD_SUPERTOKEN_ADDRESS?: string;
  CELO_GOODID_ADDRESS?: string;
  CELO_STATIC_ORACLE_ADDRESS?: string;
  CELO_CUSD_ADDRESS?: string;
  SUPERFLUID_SUBGRAPH_URL?: string;
  MAX_BONUS_CAP_USD?: string;
}

export type RuntimeConfig = {
  ANTSEED_FUNDING_RPC_URL?: string;
  ANTSEED_FUNDING_VAULT_ADDRESS?: string;
  ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY?: string;
  SLACK_WEBHOOK_URL?: string;
  /** G$ price in cUSD as a decimal number, e.g. 0.001154 means 1 G$ = 0.001154 cUSD */
  GD_CUSD_PRICE: number;
  CELO_RPC_URL?: string;
  CELO_VAULT_ADDRESS?: string;
  CELO_GD_SUPERTOKEN_ADDRESS?: string;
  CELO_GOODID_ADDRESS?: string;
  CELO_STATIC_ORACLE_ADDRESS?: string;
  CELO_CUSD_ADDRESS?: string;
  SUPERFLUID_SUBGRAPH_URL?: string;
  MAX_BONUS_CAP_USD: bigint;
};

export function configFromEnv(env: Env): RuntimeConfig {
  return {
    ANTSEED_FUNDING_RPC_URL: env.ANTSEED_FUNDING_RPC_URL,
    ANTSEED_FUNDING_VAULT_ADDRESS: env.ANTSEED_FUNDING_VAULT_ADDRESS,
    ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY: env.ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY,
    SLACK_WEBHOOK_URL: env.SLACK_WEBHOOK_URL,
    GD_CUSD_PRICE: floatEnv(env.GD_CUSD_PRICE, 0.0001),
    CELO_RPC_URL: env.CELO_RPC_URL,
    CELO_VAULT_ADDRESS: env.CELO_VAULT_ADDRESS,
    CELO_GD_SUPERTOKEN_ADDRESS: env.CELO_GD_SUPERTOKEN_ADDRESS,
    CELO_GOODID_ADDRESS: env.CELO_GOODID_ADDRESS,
    CELO_STATIC_ORACLE_ADDRESS: env.CELO_STATIC_ORACLE_ADDRESS,
    CELO_CUSD_ADDRESS: env.CELO_CUSD_ADDRESS,
    SUPERFLUID_SUBGRAPH_URL: env.SUPERFLUID_SUBGRAPH_URL,
    MAX_BONUS_CAP_USD: parseUnits(env.MAX_BONUS_CAP_USD || "100", 18)
  };
}

function bigintEnv(value: string | undefined, fallback: bigint): bigint {
  if (!value) return fallback;
  return BigInt(value);
}

function floatEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseFloat(value);
  return isFinite(n) && n > 0 ? n : fallback;
}
