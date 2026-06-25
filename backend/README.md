# Backend Worker

Cloudflare Worker for GoodDollar Celo-vault credit accounting and Celo → Base bridge funding.

## Runtime

- Wrangler Cloudflare Worker (`src/worker.ts`) only
- KV namespace binding: `ANTSEED_KV`
- Celo `CeloGdAntSeedVault` tx-log ingestion for G$ deposits and Superfluid stream updates
- Optional Base `AntseedBuyerOperator` bridge client that calls `depositForWithId(buyer, amount, id)`
- Cron trigger every minute for stream bonus settlement checks

## Endpoints

- `GET /health`
- `GET /config/status`
- `GET /v1/accounts/:account/credit`
- `GET /v1/accounts/:account/outstanding`
- `GET /v1/accounts/:account/transactions` — paginated `gdCredits` history (`status`, `limit`, `cursor`)
- `GET /v1/accounts/:account/withdrawable?buyer=0x...` — on-chain `withdrawablePrincipal`
- `POST /v1/accounts/:account/withdraw` — buyer EIP-712 sig → `withdrawPrincipal` on Base
- `POST /v1/accounts/:account/stream-credits` — manual daily stream accrual
- `POST /v1/celo/events/record`
- `POST /v1/channels/close`
- `POST /v1/channels/withdraw`

`POST /v1/celo/events/record` accepts either:
- `{ "txHash": "0x..." }`
- `{ "account": "0x...", "fromBlock": "0x...", "toBlock": "latest" }`

`POST /v1/accounts/:account/withdraw` body:
- `{ "buyerAddress": "0x...", "amountMicroUsd": "1000000", "recipient": "0x...", "timestamp": 1700000000, "buyerSig": "0x..." }`

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
