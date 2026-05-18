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
docs/                 Architecture, payment flow, operations notes, and user guide
```

## User guide

See [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) for the full user flow: buying AntSeed credits with G$, streaming G$ for bonus credits, and connecting local dev tools like VS Code/Continue, Claude Code-compatible proxies, Aider, or OpenAI SDK clients.

See [`docs/PAYMENT_FLOW.md`](docs/PAYMENT_FLOW.md) for the current payment-layer boundary: GoodDollar auth/credits sit in front of the AntSeed buyer deposits contract and buyer-signed EIP-712 reserve/settle authorization.

## Flow

1. A GoodID-verified user deposits G$ into `CeloGdAntSeedVault` on Celo, either with ERC677/ERC667 `transferAndCall`, ERC777 `tokensReceived`, or classic ERC-20 `deposit`.
2. A GoodID-verified user can also stream G$ to the vault through Superfluid; the vault reacts to SuperApp stream callbacks and emits stream-cap events.
3. The Worker verifies Celo vault logs, resolves the GoodID root with `getWhitelistedRoot(account)`, persists wallet-level and root-level user data in KV, and issues USDC-denominated AntSeed credits.
4. Standard deposits receive +10% credits. Streaming users receive +20% on principal up to their monthly stream speed; amounts above that cap receive the regular +10%.
5. The user creates a signed `gd_live_...` API key by signing a Worker nonce with the credit-owning wallet.
6. Developer tools use the Worker as their OpenAI-compatible `/v1` base URL. The Worker authenticates the API key, reserves/settles GoodDollar credits, and forwards requests to the AntSeed buyer proxy (`/v1/chat/completions`).
7. The current AntSeed upstream payment path is deposit-backed: the buyer signs EIP-712 reserve/settle authorization and the AntSeed deposits contract deducts from the deposit balance. Future payment mechanisms should be added as adapters above this layer.

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
