# GoodDollar AntSeed Credits User Guide

Use G$ on Celo to buy AntSeed AI compute credits.

This guide covers on-chain deposit/stream setup and credit balance checking. Developer-tool integration (API key auth and the OpenAI-compatible proxy) is coming in a future phase.

## Quick mental model

```text
G$ on Celo -> CeloGdAntSeedVault -> Worker verifies tx -> credit balance -> AntSeed buyer deposit funded
```

- You deposit or stream G$ to the Celo vault.
- The Worker verifies the vault transaction on Celo.
- Your credits are recorded by wallet address and by your GoodID root wallet.
- The Worker funds the backend AntSeed buyer deposit on Base via `AntseedBuyerOperator`.
- Today the upstream AntSeed payment path is deposit-backed: the buyer operator calls `IAntseedDeposits.deposit` and the AntSeed protocol settles providers from that balance.

## What you need

Ask the GoodDollar/AntSeed operator for these production values:

```bash
export GOODDOLLAR_ANTSEED_API="https://YOUR_GOODDOLLAR_ANTSEED_WORKER"
export GOODDOLLAR_ACCOUNT="0xYOUR_GOODID_WALLET"
```

Check that the API is alive:

```bash
curl "$GOODDOLLAR_ANTSEED_API/health"
curl "$GOODDOLLAR_ANTSEED_API/config/status"
curl "$GOODDOLLAR_ANTSEED_API/config/values"
```

`/config/status` shows Celo integration flags, bridge mode, and whether the Base buyer operator is enabled.
`/config/values` returns non-secret runtime values, including bonus/cap constants used by credit accounting.

## Configurable Constants

The backend operator can tune credit behavior using environment constants:

- `MAX_BONUS_CAP_USD`: monthly bonus cap shared by wallets mapped to the same GoodID root.
- `REGULAR_BONUS_BPS`: bonus rate for deposit credits.
- `STREAMING_BONUS_BPS`: bonus rate for stream credits.
- `MIN_GD_STREAMED_FOR_BONUS`: minimum streamed G$ amount required to issue stream credits.

Use `GET /config/values` to inspect the effective runtime values. Note that the response returns the stream threshold as `MIN_STREAM_BONUS_WEI` (wei units), derived from `MIN_GD_STREAMED_FOR_BONUS`.

## Why use G$ credits instead of paying USDC directly?

Plain USDC payment is simple: pay $1, receive roughly $1 of compute.

GoodDollar AntSeed credits add a GoodDollar-native credit layer:

1. **Bonus credits**
   - One-time G$ deposits receive **+10%** credits.
   - Active G$ streamers receive **+20%** credits.
   - Wallets without GoodID verification receive no bonus.
   - A per-root-account monthly bonus cap applies (`MAX_BONUS_CAP_USD`).

2. **GoodID-based bonus eligibility**
   - Any wallet can deposit or stream G$ without needing GoodID.
   - GoodID-verified wallets earn bonus credits; unverified wallets receive principal only.
   - Connected wallets are aggregated under `getWhitelistedRoot(account)`, so linked wallets share a credit history and monthly bonus cap.

3. **Monthly stream budget**
   - You can stream G$ continuously instead of topping up manually.
   - Stream credits are issued by a cron job (every minute) or on demand via `POST /v1/accounts/:account/stream-credits` (24-hour cooldown per account).

4. **On-chain proof of funding**
   - Credits come from Celo vault events, not a centralized off-chain payment button.
   - The Worker records credit only after verifying vault events.

5. **Developer-tool UX**
   - After credits are recorded, local tools can use AntSeed through normal AI API settings: base URL, model, and API key.

## Credit formula

All backend accounting is USDC-denominated in micro-USD units.

```text
principal = gdAmount * gdUsdPerToken
bonus     = principal * 10%   (deposit)
          = principal * 20%   (stream)
          = 0                  (unverified wallet)
effectiveBonus = min(bonus, MAX_BONUS_CAP_USD - monthlyBonusUsed)
totalCredits = principal + effectiveBonus
```

The G$ → USD price comes from the reserve oracle (`currentPrice`) when configured, otherwise the `GD_USD_PER_TOKEN` env var.

Examples (assuming verified wallet, bonus cap not yet reached):

| User type                 | G$ principal value | Credits issued |
| ------------------------- | -----------------: | -------------: |
| one-time deposit          |             $10.00 |         $11.00 |
| active streamer           |              $1.00 |          $1.20 |
| unverified wallet         |             $10.00 |         $10.00 |
| monthly bonus cap reached |             $10.00 |         $10.00 |

## Step 1 — Optionally verify with GoodID for bonus credits

Any wallet can deposit G$ or stream to the vault. GoodID verification is **not required** to deposit.

The Worker calls `getWhitelistedRoot(account)` on the GoodID contract. A non-zero root unlocks bonus credits (+10% for deposits, +20% for streams) and aggregates your credit history across linked wallets. Without GoodID, you receive principal credits only.

## Step 2 — Buy AntSeed credits with G$

### Option A: one-transaction G$ deposit

Preferred path: send G$ to the Celo vault with `transferAndCall`.

You must supply your AntSeed buyer account address encoded as the `data` / `userData` parameter:

```solidity
GoodDollar.transferAndCall(
  CELO_GD_ANTSEED_VAULT,
  amountGdWei,
  abi.encode(YOUR_ANTSEED_BUYER_ADDRESS)
);
```

The `data` field **must** be `abi.encode(buyerAddress)` — a 32-byte ABI-encoded address. A zero or missing buyer causes the vault to revert with `MissingBuyerAddress`.

The vault supports these single-transaction hooks:

- ERC677/ERC667 `onTokenTransfer(address,uint256,bytes)`
- ERC667-style `tokenFallback(address,uint256,bytes)`
- ERC777 `tokensReceived(...)`

After the transaction is mined, record it with the Worker:

```bash
curl -X POST "$GOODDOLLAR_ANTSEED_API/v1/celo/events/record" \
  -H "content-type: application/json" \
  -d '{"txHash":"0xYOUR_CELO_TX_HASH"}'
```

The Worker will:

1. fetch the Celo receipt,
2. parse `GdDeposited` events from the vault,
3. resolve your GoodID root,
4. issue credits into KV,
5. update wallet and root aggregates.

### Option B: classic ERC-20 deposit

If your wallet cannot call `transferAndCall`, approve and deposit:

```solidity
GoodDollar.approve(CELO_GD_ANTSEED_VAULT, amountGdWei);
CeloGdAntSeedVault.deposit(amountGdWei, abi.encode(YOUR_ANTSEED_BUYER_ADDRESS));
```

This takes two transactions, so use `transferAndCall` when possible.

## Step 3 — Stream G$ for the monthly credit boost

If you stream G$ to the Celo vault through Superfluid, the vault reacts as a SuperApp receiver.

Create or update a Constant Flow Agreement from your wallet to the vault using the G$ SuperToken on Celo.

You **must** pass your AntSeed buyer address as `userData` when creating or updating the flow:

```text
sender   = your GoodID wallet
receiver = CELO_GD_ANTSEED_VAULT
token    = G$ SuperToken on Celo
flowRate = token-wei per second
userData = abi.encode(YOUR_ANTSEED_BUYER_ADDRESS)   ← required
```

The vault's SuperApp callback decodes the buyer from `ctx.userData`. A missing or zero buyer causes `MissingBuyerAddress` revert. On stream termination the stored buyer is used automatically; you do not need to re-supply it.

When the stream is created or updated, the vault emits `StreamUpdated(account, buyer, flowRate, monthlyGdAmountWei, totalFlowWei)`, where `totalFlowWei = previousFlowRate * secondsSincePreviousUpdate`. Record the stream update through the Worker the same way:

```bash
curl -X POST "$GOODDOLLAR_ANTSEED_API/v1/celo/events/record" \
  -H "content-type: application/json" \
  -d '{"txHash":"0xYOUR_STREAM_TX_HASH"}'
```

The Worker uses this to record the stream's `totalFlowWei` as a credit entry and issue the +20% streaming bonus.

## Step 4 — Check your credit balance

```bash
curl "$GOODDOLLAR_ANTSEED_API/v1/accounts/$GOODDOLLAR_ACCOUNT/credit"
```

The response includes:

- wallet-level `UserCreditProfile` (principal, bonus, outstanding funding totals),
- GoodID-root aggregate profile when applicable,
- list of `GdCreditEntry` records with `fundingStatus` (`pending`, `funded`, or `failed`).

To see credits that have not yet been funded to the AntSeed buyer deposit:

```bash
curl "$GOODDOLLAR_ANTSEED_API/v1/accounts/$GOODDOLLAR_ACCOUNT/outstanding"
```

This returns `outstandingFundingUsd` and the list of `failed` or `pending` credit entries. Submitting the same `txHash` to `/v1/celo/events/record` again is safe — idempotency prevents double-funding.

To manually trigger stream credits outside of the cron (24-hour cooldown applies):

```bash
curl -X POST "$GOODDOLLAR_ANTSEED_API/v1/accounts/$GOODDOLLAR_ACCOUNT/stream-credits"
```

## Step 5 — Developer tool integration (coming soon)

Wallet-signature auth (`/v1/auth/nonce`, `/v1/auth/api-keys`), signed `gd_live_...` API keys, and the OpenAI-compatible `/v1/chat/completions` proxy are planned for a future phase. Once available, you will be able to point any OpenAI-compatible developer tool (Continue, Cline, Roo Code, Aider, etc.) directly at the GoodDollar AntSeed Worker.

## Troubleshooting

### Check API configuration

```bash
curl "$GOODDOLLAR_ANTSEED_API/config/status"
```

Look for:

- `celo.vaultConfigured = true`
- `celo.goodIdConfigured = true`
- `bridge.baseBuyerOperatorEnabled = true`

### Check credits

```bash
curl "$GOODDOLLAR_ANTSEED_API/v1/accounts/$GOODDOLLAR_ACCOUNT/credit"
```

If credits show `fundingStatus: "failed"`, check `fundingError` on the entry. You can retry by re-submitting the original `txHash` — idempotency prevents double-funding.

## Safety and limitations

- Credits are not USDC balances; they are GoodDollar-side accounting credits used to fund the operator's AntSeed buyer deposit.
- Current AntSeed payment is deposit/EIP-712 backed upstream; future payment mechanisms should be added as adapters above that layer.
- KV is durable but eventually consistent. On-chain vault events are the source of truth for deposits and stream updates.
