# Backend Worker

Cloudflare Worker for GoodDollar Celo-vault credit accounting and Celo → Base bridge funding.

## Runtime

- Wrangler Cloudflare Worker (`src/worker.ts`) only
- KV namespace binding: `ANTSEED_KV`
- Celo `CeloGdAntSeedVault` tx-log ingestion for G$ deposits and Superfluid stream updates
- Optional Base `AntseedBuyerOperator` bridge client that calls `depositFor(buyer, amount)`

## Endpoints

- `GET /health`
- `GET /config/status`
- `GET /v1/accounts/:account/credit`
- `GET /v1/accounts/:account/outstanding`
- `POST /v1/accounts/:account/withdraw`
- `GET /v1/requests/:requestId`
- `POST /v1/celo/events/record`
- `POST /v1/celo/deposits/manual`
- `POST /v1/celo/streams/update`
- `POST /v1/channels/close`

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
