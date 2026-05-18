# GoodDollar AntSeed Integration

Standalone AntSeed integration for GoodDollar agents.

This repository is intentionally separate from GoodDollar L2. It contains only:

- an on-chain credit vault contract for prepaid/reserved AI compute credits
- a backend credit/accounting service
- an AntSeed buyer/proxy integration using the OpenAI-compatible API exposed by the local AntSeed buyer

## What is deliberately excluded

- no GoodDollar L2 chain code
- no L2 indexer/worker
- no frontend app
- no copied code from `gooddollar-l2`

## Repository layout

```text
contracts/            Foundry project with AgentCreditVault
backend/              TypeScript Express service for credits + AntSeed calls
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
cp .env.example .env
npm install
npm run build
npm test
npm start
```

By default the backend runs in dry-run vault mode if `VAULT_ADDRESS`, `RPC_URL`, or `OPERATOR_PRIVATE_KEY` are not set. This lets you test AntSeed connectivity before deploying the vault.

## AntSeed defaults

The service expects a local buyer proxy compatible with OpenAI chat completions:

```text
ANTSEED_BASE_URL=http://127.0.0.1:8377
ANTSEED_MODEL=qwen3-235b-instruct
```

Optional pinning:

```text
ANTSEED_PIN_PEER=<peer id>
ANTSEED_PIN_SERVICE=<service id>
```
