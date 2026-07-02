# Backend Worker

Cloudflare Worker for GoodDollar Celo-vault credit accounting and Celo → Base bridge funding.

## Runtime

- Wrangler Cloudflare Worker (`src/worker.ts`) only
- KV namespace binding: `ANTSEED_KV`
- Celo `CeloGdAntSeedVault` tx-log ingestion for G$ deposits and Superfluid stream updates
- Optional Base `AntseedBuyerOperator` bridge client that calls `depositForWithId(buyer, principal, bonus, id)`
- Cron trigger every minute for stream bonus settlement checks

## Endpoints

- `GET /health`
- `GET /config/status`
- `GET /v1/accounts/:account/credit`
- `GET /v1/accounts/:account/outstanding`
- `GET /v1/accounts/:account/transactions` — paginated `gdCredits` history (`status`, `limit`, `cursor`)
- `POST /v1/accounts/:account/operator/accept` — submit buyer `SetOperator` signature → `acceptBuyerOperator` on Base
- `POST /v1/accounts/:account/withdraw` — buyer EIP-712 sig → `withdrawPrincipalForBuyer` on Base
- `POST /v1/accounts/:account/stream-credits`
- `POST /v1/celo/events/record`
- `POST /v1/channels/:channelId/close`
- `POST /v1/channels/:channelId/withdraw`

On-chain reads (operator status, withdrawable balance, oracle quotes, EIP-712 signing payloads) are handled in the UI via direct chain RPC calls, not proxied through this Worker.

`POST /v1/celo/events/record` accepts either:
- `{ "txHash": "0x..." }`
- `{ "account": "0x...", "fromBlock": "0x...", "toBlock": "latest" }`

`POST /v1/accounts/:account/operator/accept` body:
- `{ "nonce": "0", "buyerSig": "0x...", "buyerAddress": "0x..." }` — `buyerAddress` optional (defaults to account)

`POST /v1/accounts/:account/withdraw` body:
- `{ "buyerAddress": "0x...", "amountUsd": "1000000", "recipient": "0x...", "timestamp": 1700000000, "buyerSig": "0x..." }`

## Widget flow

1. UI reads operator consent state and builds/signs `SetOperator` EIP-712 locally → `POST /v1/accounts/:account/operator/accept`
2. Celo deposit → `POST /v1/celo/events/record`
3. UI reads withdrawable principal on-chain, builds/signs withdraw EIP-712 locally → `POST /v1/accounts/:account/withdraw`
4. Credit history and outstanding funding: `GET /v1/accounts/:account/credit`, `/outstanding`, `/transactions`

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
