import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(4317),
  LOG_LEVEL: z.string().default("info"),
  ANTSEED_BASE_URL: z.string().url().default("http://127.0.0.1:8377"),
  ANTSEED_MODEL: z.string().default("qwen3-235b-instruct"),
  ANTSEED_PIN_PEER: z.string().optional(),
  ANTSEED_PIN_SERVICE: z.string().optional(),
  ANTSEED_TIMEOUT_MS: z.coerce.number().default(120_000),
  PRICE_MICRO_USD_PER_1K_INPUT_TOKENS: z.coerce.bigint().default(500n),
  PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS: z.coerce.bigint().default(1_500n),
  DEFAULT_MAX_OUTPUT_TOKENS: z.coerce.number().default(1024),
  MIN_RESERVE_MICRO_USD: z.coerce.bigint().default(1_000n),
  RPC_URL: z.string().optional(),
  VAULT_ADDRESS: z.string().optional(),
  OPERATOR_PRIVATE_KEY: z.string().optional(),
  CREDIT_TOKEN_DECIMALS: z.coerce.number().default(6)
});

export const config = EnvSchema.parse(process.env);
export type Config = typeof config;
