# Payment Flow

This integration has two layers:

1. **GoodDollar credit layer** — G$ deposits/streams on Celo, bonus accounting, GoodID gating, and KV-backed credit accounting.
2. **AntSeed buyer payment layer** — Base USDC deposits in AntSeed's deposits contract plus buyer-signed EIP-712 reserve/settle authorization that pays providers.

The GoodDollar layer is not the final AntSeed payment primitive. It is an accounting and funding layer in front of a backend-controlled AntSeed buyer deposit managed by `AntseedBuyerOperator`.

## Current credit ingestion and funding path

```text
User deposits/streams G$ to CeloGdAntSeedVault on Celo
  -> POST /v1/celo/events/record  { txHash }  (or cron every minute for streams)
  -> Worker fetches Celo receipt, parses GdDeposited / StreamUpdated events
  -> Worker calls getWhitelistedRoot(account) to resolve GoodID root and verify eligibility
  -> Worker calculates principal (G$ -> micro-USD) and bonus
       deposits:  principal * 10%
       streams:   principal * 20%
       unverified accounts: bonus = 0
       monthly cap enforced per root account via monthly-bonus KV key
  -> Worker records GdCreditEntry in KV (fundingStatus = "pending")
  -> If principal + bonus == 0 (e.g. stream create / StreamUpdated with totalFlowWei = 0):
       mark entry "funded" without calling Base (rate metadata only; accrual funded later via cron/stream-credits)
  -> Else Worker calls AntSeedFundingVaultClient.depositForBuyerWithId(buyer, principal, bonus, id)
     -> checks usedDepositIds[keccak256(id)] on-chain (idempotency guard)
     -> AntseedBuyerOperator.depositForWithId(buyer, principal, bonus, id)
        -> IAntseedDeposits.deposit(buyer, principal + bonus)
  -> Worker marks GdCreditEntry fundingStatus = "funded" / "failed"
```

Pending or failed entries are visible at `GET /v1/accounts/:account/outstanding` and can be retried by re-submitting the same `txHash` (idempotency prevents double-funding). Zero-amount stream updates are recorded as funded no-ops so they do not surface as payment failures.

AI request proxying and developer tool auth are **not yet implemented** in this Worker. Those capabilities will be added in a future phase.

## Where AntSeed is actually paid/funded

The actual funding code path is:

- `backend/src/worker.ts` — calls `fundCredit(entry, store, antseedFundingVault)` after recording each `GdCreditEntry`.
- `backend/src/antseed-funding-vault.ts` — calls `depositForBuyerWithId(buyer, principal, bonus, id)`; checks `usedDepositIds` on-chain before sending the transaction to prevent duplicates.
- `contracts/src/AntseedBuyerOperator.sol` — executes `depositForWithId(buyer, principal, bonus, id)`, calls `IAntseedDeposits.deposit(buyer, principal + bonus)`, and records the deposit ID as used.

Credits are always funded to the `buyerAddress` from the Celo event, not to the depositor wallet. `totalPrincipalDeposited[buyer]` and `totalBonusDeposited[buyer]` are tracked separately on `AntseedBuyerOperator`; buyers can withdraw their principal portion (but not bonus) using a signed EIP-712 message.

## What the Worker owns today

- GoodID root resolution and aggregation via `getWhitelistedRoot(account)`.
- G$ deposit/stream event ingestion from Celo by `txHash` or account log range.
- Bonus credit calculation: deposits +10%, streams +20%; unverified accounts get no bonus; monthly per-root-account bonus cap enforced in KV.
- KV-backed user/credit accounting with `fundingStatus` lifecycle (`pending` → `funded` / `failed`).
- Idempotent funding of the `AntseedBuyerOperator` deposit — **to the AntSeed buyer address specified at deposit/stream time**, not the GoodDollar wallet address.
- Outstanding credit visibility and cron-based stream funding.

**Not yet implemented:** wallet-signature auth, `gd_live_...` API key issuance, AI request proxying, and request-level reserve/settle lifecycle.

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
