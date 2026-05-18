# GoodDollar AntSeed Integration

Standalone AntSeed integration for GoodDollar agents.

This repository is intentionally separate from GoodDollar L2. It contains only:

- an on-chain credit vault contract for prepaid/reserved AI compute credits
- a Celo G$ vault that accepts ERC677/ERC667, ERC777, and Superfluid stream callbacks
- a Cloudflare Worker backend credit/accounting service
- KV-backed long-term persistence for user/request/G$ credit data
- an AntSeed buyer/proxy integration using the OpenAI-compatible API exposed by an AntSeed buyer gateway

## What is deliberately excluded

- no GoodDollar L2 chain code
- no L2 indexer/worker
- no frontend app
- no copied code from `gooddollar-l2`

## Repository layout

```text
contracts/            Foundry project with AgentCreditVault + CeloGdAntSeedVault
backend/              Wrangler Cloudflare Worker for credits + Celo G$ ingestion + AntSeed calls
docs/                 Architecture and operations notes
```

## Flow

1. A GoodID-verified user deposits G$ into `CeloGdAntSeedVault` on Celo, either with ERC677/ERC667 `transferAndCall`, ERC777 `tokensReceived`, or classic ERC-20 `deposit`.
2. A GoodID-verified user can also stream G$ to the vault through Superfluid; the vault reacts to SuperApp stream callbacks and emits stream-cap events.
3. The Worker verifies Celo vault logs, persists user data in KV, and issues USDC-denominated AntSeed credits.
4. Standard deposits receive +10% credits. Streaming users receive +20% on principal up to their monthly stream speed; amounts above that cap receive the regular +10%.
5. The Worker reserves/settles AntSeed request costs and forwards requests to the AntSeed buyer proxy (`/v1/chat/completions`).

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
