# Backend Worker

Cloudflare Worker for GoodDollar Celo-vault credit accounting and Celo → Base bridge funding.

## Runtime

- Wrangler Cloudflare Worker (`src/worker.ts`) only
- KV namespace binding: `ANTSEED_KV`
- Celo `CeloGdAntSeedVault` tx-log ingestion for G$ deposits and Superfluid stream updates
- Optional Base `AntseedBuyerOperator` bridge client that calls `depositFor(buyer, amount)`
- Shared-secret auth (`CELO_EVENTS_API_KEY`) required for Celo ingestion endpoints that can trigger bridge spending

## Endpoints

- `GET /health`
- `GET /config/status`
- `GET /v1/accounts/:account/credit`
- `GET /v1/requests/:requestId`
- `POST /v1/celo/events/record`
- `POST /v1/celo/deposits/manual`
- `POST /v1/celo/streams/update`

`POST /v1/celo/events/record` and `POST /v1/celo/deposits/manual` require `x-api-key` (or `Authorization: Bearer`) that matches `CELO_EVENTS_API_KEY`.

## Setup

```bash
npm install
npm run typecheck
npm test
npm run build
```

For local dev:

```bash
cp .dev.vars.example .dev.vars
npm run dev
```
