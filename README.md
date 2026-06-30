# GoodDollar AntSeed Integration

Standalone AntSeed integration for GoodDollar agents.

This repository is intentionally separate from GoodDollar L2. It contains only:

- `AntseedBuyerOperator` for Base-side buyer-operator deposit/channel operations
- a Celo G$ vault that accepts ERC677/ERC667, ERC777, and Superfluid stream callbacks
- a Cloudflare Worker/Wrangler backend for Celo credit accounting and Celo -> Base bridge funding
- KV-backed long-term persistence for user/request/G$ credit data

## What is deliberately excluded

- no GoodDollar L2 chain code
- no L2 indexer/worker
- no frontend app
- no copied code from `gooddollar-l2`

## Repository layout

```text
contracts/            Foundry project with AntseedBuyerOperator + CeloGdAntSeedVault
backend/              Wrangler Cloudflare Worker for credits + Celo G$ ingestion + Base bridge funding
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
5. The Worker bridges each credited user amount to Base by calling `AntseedBuyerOperator.depositFor(user, amountUsd)`.
6. On Base, `AntseedBuyerOperator` is the configured deposits operator and can manage channel timeout actions for the buyer when needed.

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

User and request data persists in the `ANTSEED_KV` namespace. Base bridging is enabled when
`ANTSEED_FUNDING_RPC_URL`, `ANTSEED_FUNDING_VAULT_ADDRESS`, and `ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY` are set.
