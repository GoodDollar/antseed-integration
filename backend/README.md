# Backend Worker

Cloudflare Worker for GoodDollar AntSeed credit/accounting and buyer proxy integration.

## Runtime

- Wrangler Cloudflare Worker (`src/worker.ts`)
- KV namespace binding: `ANTSEED_KV`
- Optional on-chain `AgentCreditVault` integration through `ethers` with `nodejs_compat`
- AntSeed buyer proxy via OpenAI-compatible `POST /v1/chat/completions`

## Persistent KV data

KV stores long-term user and request data:

- `user:<account>` — aggregate user credit profile
- `user-requests:<account>` — recent request IDs for the account
- `request:<requestId>` — reservation lifecycle, provider receipt, and vault tx hashes

## Endpoints

- `GET /health`
- `GET /v1/accounts/:account/credit`
- `GET /v1/requests/:requestId`
- `POST /v1/credits/quote`
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
```

Important: a deployed Cloudflare Worker cannot call `127.0.0.1` on the GoodClaw host. `ANTSEED_BASE_URL` must point to a publicly reachable AntSeed buyer gateway for production.
