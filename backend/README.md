# Backend Worker

Cloudflare Worker for GoodDollar AntSeed credit/accounting and buyer proxy integration.

## Runtime

- Wrangler Cloudflare Worker (`src/worker.ts`)
- KV namespace binding: `ANTSEED_KV`
- Optional on-chain `AgentCreditVault` integration through `ethers` with `nodejs_compat`
- Celo `CeloGdAntSeedVault` tx-log ingestion for G$ deposits and Superfluid stream updates
- AntSeed buyer proxy via OpenAI-compatible `POST /v1/chat/completions`

## Persistent KV data

KV stores long-term user and request data:

- `user:<account>` — aggregate user credit profile, G$ credits, and stream cap; written for both wallet and GoodID root when different
- `user-requests:<account>` — recent AntSeed request IDs for the account
- `request:<requestId>` — reservation lifecycle, provider receipt, and vault tx hashes
- `user-gd-credits:<account>` — recent G$ credit-entry IDs
- `gd-credit:<id>` — individual G$ deposit/stream credit entry
- `stream:<account>` — current Superfluid stream state
- `stream-bonus-used:<account>:YYYY-MM` — monthly streaming bonus cap consumption

## Endpoints

- `GET /health`
- `GET /v1/accounts/:account/credit`
- `GET /v1/requests/:requestId`
- `POST /v1/credits/quote`
- `POST /v1/celo/events/record` — verifies and records Celo vault logs by `txHash`
- `POST /v1/celo/deposits/manual` — local/test fallback for manual G$ credit entry
- `POST /v1/celo/streams/update` — local/test fallback for stream state updates
- `POST /v1/chat/completions`

## Setup

```bash
npm install
npm run typecheck
npm test
npm run build
```

Create KV namespaces and update `wrangler.toml`:

```bash
wrangler kv namespace create ANTSEED_KV
wrangler kv namespace create ANTSEED_KV --preview
```

For local dev:

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

Production secrets:

```bash
wrangler secret put RPC_URL
wrangler secret put VAULT_ADDRESS
wrangler secret put OPERATOR_PRIVATE_KEY
wrangler secret put ANTSEED_PIN_PEER
wrangler secret put ANTSEED_PIN_SERVICE
wrangler secret put CELO_RPC_URL
wrangler secret put CELO_VAULT_ADDRESS
wrangler secret put CELO_GOODID_ADDRESS
```

Important: a deployed Cloudflare Worker cannot call `127.0.0.1` on the GoodClaw host. `ANTSEED_BASE_URL` must point to a publicly reachable AntSeed buyer gateway for production.

## Credit rules

- Non-streaming G$ deposits receive 110% USDC-denominated AntSeed credits.
- Active streamers receive 120% credits only up to their monthly stream-speed cap.
- Any deposit principal above the monthly stream cap receives the regular 110% credits.
- Worker records are aggregated by wallet address and also by GoodID root address from `getWhitelistedRoot(account)`.
- Example: a user streaming `$1/month` can receive at most `$1.20` credits for `$1` of monthly streamed/deposited principal; additional principal receives `$1.10` per `$1`.
