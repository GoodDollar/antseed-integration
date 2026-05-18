# GoodDollar AntSeed Integration

Standalone AntSeed integration for GoodDollar agents.

This repository is intentionally separate from GoodDollar L2. It contains only:

- an on-chain credit vault contract for prepaid/reserved AI compute credits
- a Cloudflare Worker backend credit/accounting service
- KV-backed long-term persistence for user/request data
- an AntSeed buyer/proxy integration using the OpenAI-compatible API exposed by an AntSeed buyer gateway

## What is deliberately excluded

- no GoodDollar L2 chain code
- no L2 indexer/worker
- no frontend app
- no copied code from `gooddollar-l2`

## Repository layout

```text
contracts/            Foundry project with AgentCreditVault
backend/              Wrangler Cloudflare Worker for credits + AntSeed calls
docs/                 Architecture and operations notes
```

## Flow

1. User or sponsor deposits ERC-20 funds into `AgentCreditVault` for an account.
2. Backend receives an AI request and estimates a maximum compute cost.
3. Backend reserves credit in the vault for `requestId`.
4. Backend forwards the request to AntSeed buyer proxy (`/v1/chat/completions`).
5. Backend settles the final cost and releases any unused reservation.
6. Events provide an audit trail for deposits, reservations, settlement, refunds, and withdrawals.

## Quick start

### Contracts

```bash
cd contracts
forge test
```

### Backend

```bash
cd backend
cp .dev.vars.example .dev.vars
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

By default the Worker runs in dry-run vault mode if `VAULT_ADDRESS`, `RPC_URL`, or `OPERATOR_PRIVATE_KEY` are not set. User and request data persists in the `ANTSEED_KV` namespace.

## AntSeed defaults

The service expects a local buyer proxy compatible with OpenAI chat completions:

```text
ANTSEED_BASE_URL=http://127.0.0.1:8377 # local wrangler dev only; production needs a public buyer URL
ANTSEED_MODEL=qwen3-235b-instruct
```

Optional pinning:

```text
ANTSEED_PIN_PEER=<peer id>
ANTSEED_PIN_SERVICE=<service id>
```
