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
- `GET /v1/accounts/:account/status` — dashboard: profile, operator consent, withdrawable, outstanding
- `GET /v1/accounts/:account/credit`
- `GET /v1/accounts/:account/outstanding`
- `GET /v1/accounts/:account/transactions` — paginated `gdCredits` history (`status`, `limit`, `cursor`)
- `GET /v1/accounts/:account/operator` — buyer operator consent status (`?buyer=` optional, defaults to account)
- `GET /v1/accounts/:account/operator/consent-payload` — EIP-712 typed data for operator consent (includes nonce)
- `POST /v1/accounts/:account/operator/accept` — submit buyer signature → `acceptBuyerOperator` on Base
- `GET /v1/accounts/:account/withdrawable` — on-chain `withdrawablePrincipal` (`?buyer=` optional)
- `GET /v1/accounts/:account/withdraw/payload` — EIP-712 typed data for withdraw (`amountMicroUsd`, `recipient`, optional `?buyer=`)
- `POST /v1/accounts/:account/withdraw` — buyer EIP-712 sig → `withdrawPrincipal` on Base
- `POST /v1/accounts/:account/stream-credits` — manual daily stream accrual
- `POST /v1/celo/events/record`
- `POST /v1/channels/close`
- `POST /v1/channels/withdraw`

`POST /v1/celo/events/record` accepts either:
- `{ "txHash": "0x..." }`
- `{ "account": "0x...", "fromBlock": "0x...", "toBlock": "latest" }`

`POST /v1/accounts/:account/operator/accept` body:
- `{ "buyerSig": "0x...", "buyerAddress": "0x..." }` — `buyerAddress` optional (defaults to account)

`POST /v1/accounts/:account/withdraw` body:
- `{ "buyerAddress": "0x...", "amountMicroUsd": "1000000", "recipient": "0x...", "timestamp": 1700000000, "buyerSig": "0x..." }`

## Widget flow (no Base chain details in UI)

1. `GET /v1/accounts/:account/status` — check `operator.operatorAccepted`
2. If false: `GET .../operator/consent-payload` → wallet signs `typedData` → `POST .../operator/accept`
3. Celo deposit → `POST /v1/celo/events/record`
4. Withdraw: `GET .../withdraw/payload?amountMicroUsd=...&recipient=0x...` → sign → `POST .../withdraw`

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
