# Architecture

## Boundaries

This repo is only the AntSeed credit/vault integration. It does not depend on GoodDollar L2, does not index L2 events, and does not include frontend code.

## Components

### AgentCreditVault

A minimal ERC-20 vault that supports:

- deposits on behalf of accounts
- account withdrawals from available balance
- operator-based reservations for pending AI jobs
- operator settlement/refund after the AntSeed request completes
- owner-managed operators and treasury

The vault never calls AntSeed. It only accounts for prepaid credits on-chain.

### Backend credit service

The backend is a Cloudflare Worker managed by Wrangler. It owns the operational flow:

- authenticates/identifies the requesting account
- estimates maximum cost for the model request
- reserves credit in the vault when configured
- forwards the request to the AntSeed buyer proxy
- records durable user/request state in Cloudflare KV
- settles actual cost in the vault

### AntSeed integration

The backend uses the local AntSeed buyer proxy OpenAI-compatible route:

```text
POST /v1/chat/completions
```

It can optionally set AntSeed pinning headers for peer/service selection. In production, `ANTSEED_BASE_URL` must be publicly reachable; a deployed Worker cannot reach a private `127.0.0.1` buyer running on the GoodClaw host.

## Accounting model

- `available = deposited - reserved`
- `reserve(requestId, account, amount)` moves funds from available to reserved
- `settle(requestId, actualCost)` sends actual cost to treasury and refunds the unused remainder to the account balance
- `release(requestId)` refunds the full reservation if the upstream request fails before settlement

## Non-goals

- no marketplace/indexer
- no GoodDollar L2 block processing
- no wallet UI
- no model hosting logic


## Cloudflare KV persistence

The Worker binds `ANTSEED_KV` and persists:

- `user:<account>` aggregate credit/request profile
- `user-requests:<account>` bounded recent request ID list
- `request:<requestId>` full reservation lifecycle including vault tx hashes and provider receipt hash

KV is used for long-term user data as requested. Strict high-concurrency balance enforcement should still be delegated to the on-chain vault; KV is eventually consistent.
