# Architecture

## Boundaries

This repo is only the AntSeed credit/vault integration. It does not depend on GoodDollar L2, does not index L2 events, and does not include frontend code. Celo G$ deposits and Superfluid stream updates are handled directly through the standalone Celo vault and Worker tx-log ingestion.

## Components

### AntseedBuyerOperator

A UUPS-upgradeable contract deployed on Base. It acts as the on-chain operator for the AntSeed deposits contract, bridging G$-denominated principal and bonus credits into the USDC-backed AntSeed buyer deposit.

- accepts the operator role for a buyer via `acceptBuyerOperator(buyer, nonce, sig)` → `deposits.setOperator`
- `depositFor(buyer, principal, bonus)` — pulls USDC from contract balance, calls `deposits.deposit(buyer, principal + bonus)`
- `depositForWithId(buyer, principal, bonus, id)` — same but idempotent via `usedDepositIds[keccak256(id)]`; duplicate IDs are silently skipped
- tracks `totalPrincipalDeposited[buyer]` and `totalBonusDeposited[buyer]` separately; `withdrawablePrincipal(buyer) = totalPrincipalDeposited - totalWithdrawn`
- `withdrawPrincipal(buyer, amount, recipient, timestamp, buyerSig)` — buyer EIP-712 signed principal-only withdrawal; 5-minute timestamp window; bonus is not withdrawable by buyer
- `withdrawDepositedFor(buyer, amount, recipient)` — owner-only full withdrawal from deposits
- `requestClose(channelId)` / `withdrawChannel(channelId)` — callable by owner or the channel's buyer
- `sweepToken(token, recipient, amount)` — owner-only token rescue
- `approveCurrentDeposits()` — re-approves USDC to deposits contract (used if deposits contract address changes)

### CeloGdAntSeedVault

A Celo-side G$ vault for credit issuance without a bridge. It supports:

- ERC677/ERC667 `onTokenTransfer` and `tokenFallback` single-transaction deposits
- ERC777 `tokensReceived` single-transaction deposits
- classic ERC-20 `deposit` fallback
- GoodID check (backend only): the backend calls `getWhitelistedRoot(account)` on `CELO_GOODID_ADDRESS`; a non-zero root enables bonus credits and root-account aggregation; GoodID is **not** enforced at the contract level
- minimum USD thresholds enforced on-chain: `minFirstDepositUsd` (first deposit) and `minMonthlyStreamUsd` (stream rate); converted using `reservePriceOracle.currentPrice(bytes32)` or a configurable `fallbackGdUsdPerToken`
- Superfluid SuperApp `afterAgreementCreated`, `afterAgreementUpdated`, and `afterAgreementTerminated` callbacks
- stream state events for Worker-side bonus accounting

**Buyer address requirement.** Every deposit and stream creation/update must specify the AntSeed buyer account that receives the funded credits:

- **Deposits** — the caller encodes the buyer address in the `data` / `userData` field as `abi.encode(buyerAddress)`. The vault decodes it and emits `GdDeposited(account, buyer, gdAmount, data)`. Missing or zero buyer causes a `MissingBuyerAddress` revert.
- **Streams** — the stream creator passes `userData = abi.encode(buyerAddress)` when calling `createFlow` / `updateFlow` on the Superfluid host. The vault's SuperApp callbacks call `host.decodeCtx(ctx).userData` to extract and validate the buyer. The buyer is stored on-chain in `streamBuyer[sender]` and re-used on stream termination (terminator need not re-supply it). The vault emits `StreamUpdated(account, buyer, flowRate, monthlyGdAmountWei, totalFlowWei)`.

The backend reads `buyer` directly from on-chain events (log topics) for deposit ingestion. For stream subgraph polling it reads the `userData` field on the most recent `FlowUpdatedEvent` and decodes the buyer from it. Credits are always funded to `buyerAddress`, not to the depositor wallet.

### Backend credit service

The backend is a Cloudflare Worker managed by Wrangler. Its current scope is G$ credit ingestion, accounting, and AntSeed deposit funding. It does **not** proxy AI requests.

**Event ingestion** (`POST /v1/celo/events/record`):
- fetches a Celo transaction receipt by `txHash` (or a log range by `account + fromBlock`)
- parses `GdDeposited` and `StreamUpdated` events from `CeloGdAntSeedVault`
- resolves `getWhitelistedRoot(account)` to determine GoodID verification and root-account aggregation
- records a `GdCreditEntry` in KV and calls `fundCredit` immediately

**Stream credit issuance** (`POST /v1/accounts/:account/stream-credits`):
- reads active Superfluid streams for the account from the subgraph
- computes elapsed seconds since last credit (24-hour cooldown enforced)
- records a `GdCreditEntry` per stream and calls `fundCredit`

**Cron (every minute)**:
- fetches all active incoming streams from the Superfluid subgraph
- issues stream credits for each streamer and funds them

**Credit check** (`GET /v1/accounts/:account/credit`):
- returns the user's `UserCreditProfile` and list of `GdCreditEntry` records

**Outstanding funding** (`GET /v1/accounts/:account/outstanding`):
- returns `totalOutstandingFundingUsd` and all `GdCreditEntry` records with `fundingStatus = "pending"` or `"failed"`

**Channel close** (`POST /v1/channels/close`):
- calls `AntseedBuyerOperator.requestClose(channelId)`

**Funding path** (`fundCredit`):
- calls `AntSeedFundingVaultClient.depositForBuyerWithId(buyer, principal, bonus, id)` — uses the `buyer` from the credit entry, or falls back to `account`
- on success: marks entry `funded`, decrements `totalOutstandingFundingUsd`
- on failure: marks entry `failed`, preserves `fundingError`

### AntSeed payment boundary

The `AntseedBuyerOperator` contract (Base) is the on-chain operator for the backend's AntSeed buyer. The Worker's `AntSeedFundingVaultClient` calls `depositForWithId` to move principal + bonus credits into the AntSeed deposits contract. The AntSeed network then settles providers from the deposit balance using buyer-signed EIP-712 authorization.

Future payment mechanisms (sponsorships, org budgets, subscriptions, multi-buyer routing) should be added as adapter/router layers above this boundary.

## Accounting model

- G$ amounts are converted to micro-USD principal using the on-chain reserve oracle price (`currentPrice(bytes32)`) or the fallback `GD_USD_PER_TOKEN`
- regular bonus = `principal * 10%` (deposit and non-stream sources)
- streaming bonus = `principal * 20%` (sources: `streamUpdate`, `streamRequest`, `streamCron`)
- unverified accounts (no GoodID root): bonus = 0
- monthly bonus cap: the effective bonus is capped to `MAX_BONUS_CAP_USD - monthlyBonusUsed` for the root account; cap is tracked in `monthly-bonus:<rootAccount>:YYYY-MM`
- total credit = `principalUsd + effectiveBonusUsd`
- `totalOutstandingFundingUsd` tracks credit not yet successfully funded to `AntseedBuyerOperator`; decremented when `fundingStatus` transitions to `"funded"`

## Non-goals

- no marketplace/indexer
- no GoodDollar L2 block processing
- no wallet UI
- no model hosting logic


## Cloudflare KV persistence

The Worker binds `ANTSEED_KV` and persists:

- `user:<account>` — `UserCreditProfile` aggregate, written for both the depositor wallet and the GoodID root wallet when they differ; tracks `totalGdDepositedWei`, `totalPrincipalUsd`, `totalBonusUsd`, `totalGDStreamedWei`, `totalOutstandingFundingUsd`, `streamFlowRateWeiPerSecond`, `lastStreamCreditAt`
- `user-gd-credits:<account>` — bounded list (last 500) of `gd-credit` entry IDs for the account
- `gd-credit:<id>` — individual `GdCreditEntry`: source, amounts, `fundingStatus` (`pending` → `funded` or `failed`), `fundingTxHash`, `fundingError`, `buyerAddress`
- `monthly-bonus:<rootAccount>:YYYY-MM` — cumulative bonus issued to the root account in that calendar month; used to enforce `MAX_BONUS_CAP_USD`

KV is used for long-term user data. High-concurrency balance enforcement for the AntSeed buyer deposit is handled on-chain by `AntseedBuyerOperator`; KV is eventually consistent.
