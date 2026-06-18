# Payment Flow

This integration has two layers:

1. **GoodDollar user/credit layer** — GoodID auth, G$ deposits/streams, bonus accounting, API keys, and local developer-tool UX.
2. **AntSeed buyer payment layer** — Base USDC deposits in AntSeed's deposits contract plus buyer-signed EIP-712 reserve/settle authorization that pays providers.

The GoodDollar layer is not the final AntSeed payment primitive. It is user-facing accounting and authorization in front of a backend-controlled AntSeed buyer deposit.

## Current request path

```text
Developer tool
  -> GoodDollar AntSeed Worker /v1/chat/completions
  -> verified gd_live API key maps to wallet / GoodID root
  -> Worker checks and reserves the user's GoodDollar credit balance
  -> Worker ensures the backend AntSeed buyer has enough Base USDC deposit capacity
     -> AntSeedFundingVaultClient.ensureBuyerBalance(max reserve)
     -> BaseUsdcAntSeedVault.fundAntSeedDeposit(top-up)
     -> USDC approve(AntSeed deposits contract, top-up)
     -> AntSeed deposits.deposit(backend buyer, top-up)
  -> Worker forwards request through the configured AntSeed buyer gateway
  -> buyer gateway signs AntSeed EIP-712 reserve/settle authorization
  -> AntSeed deposits/channel contracts settle providers from the backend buyer deposit
  -> Worker settles/deducts the user's GoodDollar credits and returns the model response
```

## Where AntSeed is actually paid/funded

`AgentCreditVault` is not the AntSeed payment rail. It only tracks account-level credit reservations/settlement when enabled.

The actual funding code path is:

- `backend/src/worker.ts` — calls `antseedFundingVault.ensureBuyerBalance(maxCostMicroUsd)` before `antseed.chatCompletion(...)`.
- `backend/src/antseed-funding-vault.ts` — reads the backend buyer balance and calls `fundAntSeedDeposit(topUp)` if the buyer deposit is too low.
- `contracts/src/BaseUsdcAntSeedVault.sol` — does the on-chain USDC approval and deposit:
  - `_safeApprove(depositsAddress, amount)`
  - `antSeedDeposits.deposit(antSeedBuyer, amount)`
  - `_safeApprove(depositsAddress, 0)`

This funds a single backend/operator AntSeed buyer balance. Developers do not receive withdrawable USDC balances in AntSeed for the MVP.

## What the Worker owns today

- Wallet-signature auth for issuing `gd_live_...` API keys.
- GoodID root resolution and aggregation.
- G$ deposit/stream event ingestion from Celo.
- Bonus credit calculation: regular +10%, streaming +20% up to monthly stream-speed cap.
- KV-backed user/request/credit accounting.
- Request-level reserve/release/settle lifecycle for the GoodDollar credit layer.
- Ensuring the backend AntSeed buyer deposit is funded from the Base USDC vault — **to the AntSeed buyer address specified at deposit/stream time**, not the GoodDollar wallet address.
- Forwarding the model request to the AntSeed buyer gateway.

## What the AntSeed buyer/deposits layer owns today

- Actual network-side buyer funding and provider payment from the backend buyer deposit.
- Deposit contract balance accounting for the backend buyer address.
- Buyer-signed EIP-712 authorization for reserve/settle against deposits.
- Provider/payment settlement semantics inside the AntSeed network.

## Future payment adapter layer

Future versions can put a richer payment router between GoodDollar auth/accounting and the AntSeed buyer/deposits layer, for example:

- direct GoodDollar balance spending,
- sponsored requests,
- organization/team budgets,
- prepaid credit buckets,
- delegated allowances,
- subscriptions and recurring streams,
- routing across multiple buyer accounts or payment sources.

Those future mechanisms should be added as adapters above the current deposit/EIP-712 layer, not by giving each developer a withdrawable USDC balance in AntSeed for this MVP.
