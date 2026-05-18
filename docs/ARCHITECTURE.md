# Architecture

## Boundaries

This repo is only the AntSeed credit/vault integration. It does not depend on GoodDollar L2, does not index L2 events, and does not include frontend code. Celo G$ deposits and Superfluid stream updates are handled directly through the standalone Celo vault and Worker tx-log ingestion.

## Components

### AgentCreditVault

A minimal ERC-20 vault that supports:

- deposits on behalf of accounts
- account withdrawals from available balance
- operator-based reservations for pending AI jobs
- operator settlement/refund after the AntSeed request completes
- owner-managed operators and treasury

The vault never calls AntSeed. It only accounts for prepaid credits on-chain.

### CeloGdAntSeedVault

A Celo-side G$ vault for credit issuance without a bridge. It supports:

- ERC677/ERC667 `onTokenTransfer` and `tokenFallback` single-transaction deposits
- ERC777 `tokensReceived` single-transaction deposits
- classic ERC-20 `deposit` fallback
- GoodID gating using `isWhitelisted(account)` or `getWhitelistedRoot(account) != 0x0`
- Superfluid SuperApp `afterAgreementCreated`, `afterAgreementUpdated`, and `afterAgreementTerminated` callbacks
- stream state events with monthly stream-speed cap data for Worker-side bonus accounting

### Backend credit service

The backend is a Cloudflare Worker managed by Wrangler. It owns the operational flow:

- authenticates/identifies the requesting account
- estimates maximum cost for the model request
- reserves credit in the vault when configured
- forwards the request to the AntSeed buyer proxy
- verifies Celo vault transaction logs by `txHash` when `CELO_RPC_URL` and `CELO_VAULT_ADDRESS` are configured
- resolves `getWhitelistedRoot(account)` when `CELO_GOODID_ADDRESS` is configured and writes an additional aggregate for the GoodID root wallet
- records durable user/request/G$ credit state in Cloudflare KV
- applies +10% regular credits and +20% streaming credits up to monthly stream-speed cap
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
- G$ deposits are converted to principal credits using `GD_MICRO_USD_PER_TOKEN`
- regular bonus = `principal * 10%`
- streaming extra bonus = `min(principal, monthlyStreamCapRemaining) * 10%`
- total credit = principal + regular bonus + streaming extra bonus

## Non-goals

- no marketplace/indexer
- no GoodDollar L2 block processing
- no wallet UI
- no model hosting logic


## Cloudflare KV persistence

The Worker binds `ANTSEED_KV` and persists:

- `user:<account>` aggregate credit/request/G$ profile, written for both the sending wallet and the GoodID root wallet when they differ
- `user-requests:<account>` bounded recent request ID list
- `request:<requestId>` full reservation lifecycle including vault tx hashes and provider receipt hash
- `user-gd-credits:<account>` bounded recent G$ credit entry list
- `gd-credit:<id>` individual G$ credit entry
- `stream:<account>` current Superfluid stream state
- `stream-bonus-used:<account>:YYYY-MM` monthly stream-cap consumption

KV is used for long-term user data as requested. Strict high-concurrency balance enforcement should still be delegated to the on-chain vault; KV is eventually consistent.
