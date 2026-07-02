# Agent Operating Guide

This is the always-read operating contract for coding agents working in this repository.
Read this document before changing code or proposing integration details.

## Repository purpose

`GoodDollar/antseed-integration` is the backend + smart-contract integration layer for buying AntSeed AI compute credits with G$.

It intentionally contains:

- Celo/G$ credit vault contracts for deposit/stream-based credit issuance.
- A Cloudflare Worker backend for G$ credit accounting, Celo event ingestion, and AntSeed buyer deposit funding via `AntseedBuyerOperator`.
- Documentation for the payment boundary between the GoodDollar-facing credit layer and the current AntSeed USDC/deposit-backed buyer layer.

It intentionally does **not** contain frontend/widget code. UI work belongs in `GoodDollar/GoodWidget` and should consume this repo as backend/API/smart-contract reference.

## Quick start for agents

1. Read the GitHub issue or task body.
2. Read this file.
3. Read these references before coding:
   - `README.md`
   - `docs/ARCHITECTURE.md`
   - `docs/PAYMENT_FLOW.md`
   - `backend/README.md` for API endpoints and Worker rules
   - relevant contract files under `contracts/src/`
4. Preserve the architecture boundary: all backend/API logic belongs in the Cloudflare Worker, not a standalone Node HTTP server.
5. Keep frontend/UI changes out of this repo unless the issue explicitly changes repository scope.

## Architecture boundaries

### GoodDollar credit layer

Owned here:

- G$ deposit/stream event ingestion from Celo.
- GoodID root resolution and aggregation via `getWhitelistedRoot(account)`.
- Bonus credit calculation: deposits +10%, streams +20%; unverified accounts get no bonus; monthly per-root-account cap.
- Idempotent AntSeed buyer deposit funding via `AntseedBuyerOperator.depositForWithId`.
- KV-backed user/credit persistence with `fundingStatus` lifecycle.
- Outstanding credit tracking and cron-based stream funding.

**Planned (not yet implemented):** wallet-signature auth, `gd_live_...` API key issuance, OpenAI-compatible AI request proxy, request-level reserve/settle lifecycle.

### AntSeed buyer/payment layer

Owned by the AntSeed buyer/protocol stack, not replaced here:

- Buyer network funding.
- USDC/deposit-backed payment capacity.
- Buyer-signed EIP-712 reserve/settle authorization.
- Provider settlement semantics inside the AntSeed network.

This repo sits in front of that layer. Do not describe the G$ credit layer as native seller settlement unless a specific issue implements that future protocol change.

## Expected current request path

```text
User deposits/streams G$ to CeloGdAntSeedVault on Celo
  -> POST /v1/celo/events/record  { txHash }  (or cron for streams)
  -> Worker fetches Celo receipt, parses GdDeposited / StreamUpdated
  -> Worker resolves GoodID root, calculates principal + bonus
  -> Worker records GdCreditEntry (fundingStatus = "pending")
  -> Worker calls AntSeedFundingVaultClient.depositForBuyerWithId(buyer, principal, bonus, id)
     -> AntseedBuyerOperator.depositForWithId (Base chain)
        -> IAntseedDeposits.deposit(buyer, total)
  -> Worker marks entry "funded" or "failed"
```

AI request proxying, auth, and developer tool endpoints are **not yet implemented** in this Worker. Do not add OpenAI-compatible proxy logic or auth endpoints unless an issue explicitly scopes that work.

## Executable commands

### Backend Worker

```bash
cd backend
npm ci
npm run typecheck
npm run check:worker-only
npm test
npm run build
```

Use `npm run lint` for the Worker-only guard plus typecheck.

### Contracts

```bash
cd contracts
forge test -vvv
```

### Full quick verification

```bash
cd backend && npm ci && npm run lint && npm test && npm run build
cd ../contracts && forge test -vvv
```

## Package/layout guide

```text
contracts/            Foundry project; Celo vault and Base operator contracts
backend/              Cloudflare Worker; credit accounting, Celo event ingestion, AntSeed deposit funding
docs/                 Architecture, payment flow, and user/developer guide
```

Important backend files:

- `backend/src/worker.ts` — HTTP routing and Worker entrypoint.
- `backend/src/antseed-funding-vault.ts` — `AntseedBuyerOperator` deposit client.
- `backend/src/kv-credit-store.ts` — KV user/credit persistence.
- `backend/src/celo-events.ts` — Celo G$ vault event parsing/verification and GD price oracle.
- `backend/src/credit-bonus.ts` — bonus calculations and GD-to-micro-USD conversion.
- `backend/src/types.ts` — shared Worker domain types.
- `backend/src/env.ts` — Worker environment bindings and runtime config.

Important contract files:

- `contracts/src/CeloGdAntSeedVault.sol` — Celo G$ deposit/stream vault.
- `contracts/src/AntseedBuyerOperator.sol` — Base UUPS operator contract for AntSeed buyer deposits.

## API contract for UI/widget agents

UI agents in `GoodDollar/GoodWidget` should treat this repo as the source of truth for:

- Auth/API key endpoints listed in `backend/README.md`.
- Credit quote and account balance endpoints.
- Celo deposit/stream event ingestion flows.
- Outstanding credit and stream-credits endpoints.
- OpenAI-compatible `POST /v1/chat/completions` behavior (planned; not yet implemented).

If real deployed backend URLs are not provided in an issue, use Storybook/fixture mocks in GoodWidget rather than inventing production endpoints.

## Always / ask first / never

### Always

- Keep Worker APIs versioned under `/v1` where applicable.
- Preserve the idempotency contract: `depositForWithId` must never double-fund the same entry ID.
- Keep `fundingStatus` lifecycle (`pending` → `funded` / `failed`) on `GdCreditEntry` correct.
- Include tests for credit-bonus calculations, KV persistence, and Worker routes when modifying those areas.
- Update docs when changing user-visible flows, payment boundaries, or API contracts.

### Ask first

- Changing payment-rail assumptions or implying native G$ seller settlement.
- Adding a new runtime outside Cloudflare Worker.
- Moving frontend/widget code into this repo.
- Changing the public `gd_live_...` API key model.
- Changing contract storage/accounting semantics.

### Never

- Add a standalone Express/Fastify/Node HTTP backend for production API logic.
- Hide the current AntSeed USDC/deposit-backed upstream payment boundary.
- Store raw API keys in KV; store token hashes only (when auth is implemented).
- Put GoodWidget UI package code in this repository.
- Remove tests or CI checks to make a change pass.
- Add OpenAI-compatible proxy logic, auth endpoints, or reserve/settle lifecycle unless an issue explicitly scopes that work.

## PR requirements

- Reference the issue number in the PR title/body.
- Summarize architecture/payment-boundary impact.
- Include verification commands run and results.
- Mirror relevant acceptance criteria from the issue.
- For UI-related integration requests, prefer updating docs/API contracts here and implementing UI in `GoodDollar/GoodWidget`.
