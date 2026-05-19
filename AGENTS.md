# Agent Operating Guide

This is the always-read operating contract for coding agents working in this repository.
Read this document before changing code or proposing integration details.

## Repository purpose

`GoodDollar/antseed-integration` is the backend + smart-contract integration layer for buying AntSeed AI compute credits with G$.

It intentionally contains:

- Celo/G$ credit vault contracts for prepaid/reserved AI compute credits.
- A Cloudflare Worker backend for wallet auth, API keys, G$ credit accounting, request reserve/capture/release, and OpenAI-compatible proxying to an AntSeed buyer gateway.
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

### GoodDollar user/credit layer

Owned here:

- Wallet-signature auth and `gd_live_...` API key issuance.
- G$ deposit/stream event ingestion.
- GoodID root resolution and aggregation.
- Credit quote, reserve, settle/capture, and release lifecycle.
- KV-backed user/request/credit persistence.
- OpenAI-compatible proxy endpoint for developer tools.

### AntSeed buyer/payment layer

Owned by the AntSeed buyer/protocol stack, not replaced here:

- Buyer network funding.
- USDC/deposit-backed payment capacity.
- Buyer-signed EIP-712 reserve/settle authorization.
- Provider settlement semantics inside the AntSeed network.

This repo sits in front of that layer. Do not describe the G$ credit layer as native seller settlement unless a specific issue implements that future protocol change.

## Expected request path

```text
Developer AI tool
  -> GoodDollar AntSeed Worker /v1/chat/completions
  -> Worker authenticates gd_live API key
  -> Worker checks/reserves GoodDollar credits
  -> Worker forwards to configured AntSeed buyer gateway
  -> AntSeed buyer/protocol handles upstream payment
  -> Worker captures actual billable credits or releases hold on failure
  -> response streams/returns to developer tool
```

For the minimal product, developer tools can point directly at the hosted Worker OpenAI-compatible `/v1` endpoint. A branded local `antproxy` wrapper may be added later as a convenience layer, but do not assume the existing raw `antseed buyer start` proxy forwards requests to the GoodDollar Worker.

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
contracts/            Foundry project; vault/accounting contracts
backend/              Cloudflare Worker; auth, credits, API keys, proxying, KV persistence
docs/                 Architecture, payment flow, and user/developer guide
```

Important backend files:

- `backend/src/worker.ts` — HTTP routing and Worker entrypoint.
- `backend/src/antseed-client.ts` — upstream AntSeed buyer gateway integration.
- `backend/src/auth-store.ts` — nonce/API key auth storage helpers.
- `backend/src/kv-credit-store.ts` — KV user/request/credit persistence.
- `backend/src/celo-events.ts` — Celo G$ vault event parsing/verification.
- `backend/src/pricing.ts` — quote and credit bonus calculations.
- `backend/src/types.ts` — shared Worker domain types.

Important contract files:

- `contracts/src/AgentCreditVault.sol` — prepaid/reserved AI credit accounting vault.
- `contracts/src/CeloGdAntSeedVault.sol` — Celo G$ deposit/stream vault.

## API contract for UI/widget agents

UI agents in `GoodDollar/GoodWidget` should treat this repo as the source of truth for:

- Auth/API key endpoints listed in `backend/README.md`.
- Credit quote and account balance endpoints.
- Celo deposit/stream event ingestion flows.
- OpenAI-compatible `POST /v1/chat/completions` behavior.
- Hold/capture/release billing wording from `docs/PAYMENT_FLOW.md`.

If real deployed backend URLs are not provided in an issue, use Storybook/fixture mocks in GoodWidget rather than inventing production endpoints.

## Always / ask first / never

### Always

- Keep Worker APIs versioned under `/v1` where applicable.
- Preserve OpenAI-compatible request/response shapes for developer tools.
- Use hold/reserve before request, capture/settle after successful billable response, and release on failure/non-billable response.
- Keep request lifecycle records durable enough for reconciliation and support.
- Include tests for pricing, auth, KV persistence, and Worker routes when modifying those areas.
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
- Store raw API keys in KV; store token hashes only.
- Treat client-reported token usage as the only source of billing truth.
- Put GoodWidget UI package code in this repository.
- Remove tests or CI checks to make a change pass.

## PR requirements

- Reference the issue number in the PR title/body.
- Summarize architecture/payment-boundary impact.
- Include verification commands run and results.
- Mirror relevant acceptance criteria from the issue.
- For UI-related integration requests, prefer updating docs/API contracts here and implementing UI in `GoodDollar/GoodWidget`.
