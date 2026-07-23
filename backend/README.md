# Backend Worker

Cloudflare Worker for GoodDollar Celo-vault credit accounting and Celo → Base bridge funding.

## Runtime

- Wrangler Cloudflare Worker (`src/worker.ts`) only
- KV namespace binding: `ANTSEED_KV`
- Celo `CeloGdAntSeedVault` tx-log ingestion for G$ deposits and Superfluid stream updates
- Optional Base `AntseedBuyerOperator` bridge client that calls `depositForWithId(buyer, principal, bonus, id)`
- Cron trigger every minute for stream bonus settlement checks
- Analytics refresh runs on cron with a 6-hour interval guard and can be queried at `/analytics`

## Endpoints

- `GET /health`
- `GET /config/status`
- `GET /config/values`
- `GET /analytics`
- `GET /v1/accounts/:account/profile`
- `GET /v1/accounts/:account/credit-history`
- `GET /v1/accounts/:account/outstanding`
- `POST /v1/accounts/:account/stream-credits`
- `POST /v1/accounts/:account/operator-consent`
- `POST /v1/accounts/:account/withdraw`
- `POST /v1/celo/events/record`
- `POST /v1/channels/:channelId/close`
- `POST /v1/channels/:channelId/withdraw`

`GET /analytics` returns daily analytics and global totals:

- query: `days` (default `30`, max `365`)
- optional query: `refresh=true` to trigger an on-demand refresh before reading
- response: `{ days, daily, global, lastRun }`

`GET /v1/accounts/:account/profile` returns the wallet `UserCreditProfile` only.

`GET /v1/accounts/:account/credit-history` returns paginated `GdCreditEntry` history (newest first):

- query: `limit` (default `20`, max `100`), `offset` (default `0`)
- filters: `source`, `fundingStatus`, `from` / `to` (ISO timestamps on `createdAt`, inclusive)
- response: `{ account, items, total, limit, offset, hasMore }`

`POST /v1/celo/events/record` accepts either:

- `{ "txHash": "0x..." }`
- `{ "account": "0x...", "fromBlock": "0x...", "toBlock": "latest" }`

## Setup

```bash
npm install
npm run typecheck
npm test
npm run build
```

Optional secrets/config:

- `SLACK_WEBHOOK_URL` - receives a notification when a fetch request ends with an uncaught exception. The payload includes the request method, path, raw body, and error message.
- `MAX_BONUS_CAP_USD` - monthly per-root-account bonus cap (token units, 18 decimals), defaults to `100`.
- `REGULAR_BONUS_BPS` - bonus basis points for deposits/non-stream sources, defaults to `1000` (10%).
- `STREAMING_BONUS_BPS` - bonus basis points for stream sources, defaults to `2000` (20%).
- `MIN_GD_STREAMED_FOR_BONUS` - minimum stream amount in G$ to issue stream credits, defaults to `4000`.
- `BASE_RPC_URL` - optional explicit Base RPC URL for analytics (falls back to `ANTSEED_FUNDING_RPC_URL`).
- `BASE_CHANNELS_ADDRESS` - Base AntseedChannels contract address used for analytics log ingestion.
- `ANALYTICS_REFRESH_INTERVAL_SECONDS` - minimum time between analytics refresh runs, defaults to `21600` (6 hours).

## Config And Constants

The Worker reads constants from Wrangler env vars and derives runtime values in `src/env.ts`.

- `GD_CUSD_PRICE`
  - Decimal cUSD price per 1 G$ used as fallback pricing.
  - Default: `0.0001`.
- `MAX_BONUS_CAP_USD`
  - Monthly bonus cap per GoodID root account.
  - Input units: token units with 18 decimals (e.g. `100`).
  - Runtime representation: `MAX_BONUS_CAP_USD` bigint (18 decimals).
- `REGULAR_BONUS_BPS`
  - Bonus rate for non-stream sources (`deposit`).
  - Basis points where `10000 = 100%`.
  - Default: `1000` (10%).
- `STREAMING_BONUS_BPS`
  - Bonus rate for stream sources (`streamUpdate`, `streamRequest`, `streamCron`).
  - Basis points where `10000 = 100%`.
  - Default: `2000` (20%).
- `MIN_GD_STREAMED_FOR_BONUS`
  - Minimum streamed G$ amount required before stream credits are issued.
  - Input units: whole-token G$ string parsed to wei.
  - Runtime representation: `MIN_STREAM_BONUS_WEI` bigint.
  - Default: `4000` G$.

### Inspect Runtime Values

Use `GET /config/values` to inspect the effective non-secret config values currently used by the Worker.

```bash
curl "$GOODDOLLAR_ANTSEED_API/config/values"
```

Important response fields:

- `config.GD_CUSD_PRICE`
- `config.MAX_BONUS_CAP_USD`
- `config.REGULAR_BONUS_BPS`
- `config.STREAMING_BONUS_BPS`
- `config.MIN_STREAM_BONUS_WEI` (derived from `MIN_GD_STREAMED_FOR_BONUS`)

For local dev:

```bash
cp .dev.vars.example .dev.vars
npm run dev
```
