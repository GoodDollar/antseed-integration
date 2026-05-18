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

The backend owns the operational flow:

- authenticates/identifies the requesting account
- estimates maximum cost for the model request
- reserves credit in the vault when configured
- forwards the request to the AntSeed buyer proxy
- records local request state
- settles actual cost in the vault

### AntSeed integration

The backend uses the local AntSeed buyer proxy OpenAI-compatible route:

```text
POST /v1/chat/completions
```

It can optionally set AntSeed pinning headers for peer/service selection.

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
