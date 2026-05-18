# GoodDollar AntSeed Credits User Guide

Use G$ on Celo to buy AntSeed compute credits, then point your local AI coding tools at the GoodDollar AntSeed Worker API.

This guide is for users and developers. It intentionally does **not** require bridging G$ anywhere: deposits and streams happen on Celo.

## Quick mental model

```text
G$ on Celo -> CeloGdAntSeedVault -> Worker verifies tx -> KV credit balance -> AntSeed API -> local dev tools
```

- You deposit or stream G$ to the Celo vault.
- The Worker verifies the vault transaction on Celo.
- Your credits are recorded by wallet address and by your GoodID root wallet.
- Your local tools call the Worker as an OpenAI-compatible chat-completions endpoint.
- The Worker reserves credits, forwards the request to AntSeed, then settles the actual usage.

## Why use G$ credits instead of paying USDC directly?

Plain USDC payment is simple: pay $1, receive roughly $1 of compute.

GoodDollar AntSeed credits are different:

1. **Bonus credits**
   - One-time G$ deposits receive **+10%** credits.
   - Active G$ streamers receive **+20%** credits up to their monthly stream-speed cap.

2. **GoodID-gated access**
   - Deposits and stream creation require a GoodID-verified wallet.
   - Connected wallets are aggregated under `getWhitelistedRoot(account)`, so a user can use linked wallets without splitting identity or credit history.

3. **Streaming-friendly budget**
   - You can stream G$ monthly instead of topping up manually.
   - Example: if your stream speed equals `$1/month` worth of G$, up to `$1` of monthly principal receives `$1.20` of credits. Any additional principal gets the regular `$1.10` per `$1`.

4. **Non-custodial proof of funding**
   - Credits come from Celo vault events, not from a centralized off-chain payment button.
   - The Worker records the credit balance after verifying on-chain events.

5. **Developer UX**
   - Once credits are recorded, local tools can call the Worker with a normal chat-completions request plus your wallet address.

## Credit formula

All backend accounting is USDC-denominated in micro-USD units.

```text
regularBonus = principal * 10%
streamingExtraBonus = min(principal, remainingMonthlyStreamCap) * 10%
totalCredits = principal + regularBonus + streamingExtraBonus
```

Examples:

| User type | G$ principal value | Monthly stream cap left | Credits issued |
|---|---:|---:|---:|
| one-time deposit | $10.00 | $0.00 | $11.00 |
| active streamer | $1.00 | $1.00 | $1.20 |
| active streamer, above cap | $10.00 | $1.00 | $11.10 |
| cap already used | $10.00 | $0.00 | $11.00 |

The exact G$ -> USD conversion depends on `GD_MICRO_USD_PER_TOKEN` in the Worker config until a production oracle/quote path is wired.

## Step 1 — Check GoodID

Your deposit wallet must be GoodID verified.

The vault accepts either:

- `isWhitelisted(account) == true`, or
- `getWhitelistedRoot(account) != address(0)`

The Worker also uses `getWhitelistedRoot(account)` to maintain a second aggregate record for your GoodID root wallet.

## Step 2 — Buy credits with G$

### Option A: one-transaction G$ deposit

Preferred path: send G$ to the Celo vault with `transferAndCall`.

```solidity
GoodDollar.transferAndCall(
  CELO_GD_ANTSEED_VAULT,
  amountGdWei,
  userData
);
```

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
CeloGdAntSeedVault.deposit(amountGdWei, userData);
```

This takes two transactions, so use `transferAndCall` when possible.

## Step 3 — Stream G$ for monthly credit boost

If you stream G$ to the Celo vault through Superfluid, the vault reacts as a SuperApp receiver.

The vault handles:

- `beforeAgreementCreated`
- `afterAgreementCreated`
- `beforeAgreementUpdated`
- `afterAgreementUpdated`
- `beforeAgreementTerminated`
- `afterAgreementTerminated`

Create or update a Constant Flow Agreement from your wallet to the vault, using the G$ SuperToken on Celo.

Conceptually:

```text
sender = your GoodID wallet
receiver = CELO_GD_ANTSEED_VAULT
token = G$ SuperToken on Celo
flowRate = token-wei per second
```

When the stream is created or updated, the vault emits `StreamUpdated(account, flowRate, monthlyGdAmountWei)`. Record the stream update through the Worker the same way:

```bash
curl -X POST "$GOODDOLLAR_ANTSEED_API/v1/celo/events/record" \
  -H "content-type: application/json" \
  -d '{"txHash":"0xYOUR_STREAM_TX_HASH"}'
```

The Worker uses this to calculate your monthly stream cap for the extra 10% streaming bonus.

## Step 4 — Check your credit balance

```bash
curl "$GOODDOLLAR_ANTSEED_API/v1/accounts/0xYOUR_WALLET/credit"
```

The response includes:

- wallet-level profile,
- GoodID-root aggregate profile when applicable,
- G$ credit entries,
- AntSeed request history,
- current stream cap,
- available credit balance.

## Step 5 — Connect local dev tools

The Worker exposes an OpenAI-compatible chat-completions endpoint:

```text
POST /v1/chat/completions
```

Most tools need:

```bash
export GOODDOLLAR_ANTSEED_API="https://YOUR_WORKER.workers.dev"
export GOODDOLLAR_ACCOUNT="0xYOUR_GOODID_WALLET"
export OPENAI_API_KEY="gooddollar-antseed"
export OPENAI_BASE_URL="$GOODDOLLAR_ANTSEED_API/v1"
```

The API key is currently only a client compatibility placeholder unless auth middleware is added. Credit authorization is based on the wallet account and KV credit balance.

### Standard request

```bash
curl "$GOODDOLLAR_ANTSEED_API/v1/chat/completions" \
  -H "content-type: application/json" \
  -H "x-gooddollar-account: $GOODDOLLAR_ACCOUNT" \
  -d '{
    "model": "qwen3-235b-instruct",
    "messages": [
      { "role": "user", "content": "Write a short TypeScript function." }
    ],
    "max_tokens": 512
  }'
```

You can also include `account` in the JSON body:

```json
{
  "account": "0xYOUR_GOODID_WALLET",
  "model": "qwen3-235b-instruct",
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

## VS Code / Continue

Example `~/.continue/config.json` model entry:

```json
{
  "models": [
    {
      "title": "GoodDollar AntSeed",
      "provider": "openai",
      "model": "qwen3-235b-instruct",
      "apiBase": "https://YOUR_WORKER.workers.dev/v1",
      "apiKey": "gooddollar-antseed",
      "requestOptions": {
        "headers": {
          "x-gooddollar-account": "0xYOUR_GOODID_WALLET"
        }
      }
    }
  ]
}
```

If your VS Code extension does not support custom headers, run a tiny local proxy that injects `x-gooddollar-account`, or use a tool that can put `account` in the request body.

## Claude Code

Claude Code is Anthropic-native. There are two practical connection patterns:

### Pattern A: OpenAI-compatible proxy

Run a local compatibility proxy that accepts Anthropic-format requests from Claude Code and forwards OpenAI-format requests to:

```text
https://YOUR_WORKER.workers.dev/v1/chat/completions
```

The proxy should inject:

```text
x-gooddollar-account: 0xYOUR_GOODID_WALLET
```

Use this when your Claude Code setup only supports Anthropic APIs.

### Pattern B: Direct OpenAI-compatible mode, if available in your tooling

If your local agent/runtime supports OpenAI-compatible model settings, configure:

```bash
export OPENAI_BASE_URL="https://YOUR_WORKER.workers.dev/v1"
export OPENAI_API_KEY="gooddollar-antseed"
export GOODDOLLAR_ACCOUNT="0xYOUR_GOODID_WALLET"
```

Then configure the tool to send `x-gooddollar-account` on every request, or use a wrapper/proxy that adds it.

## OpenAI SDK example

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "gooddollar-antseed",
  baseURL: "https://YOUR_WORKER.workers.dev/v1",
  defaultHeaders: {
    "x-gooddollar-account": "0xYOUR_GOODID_WALLET"
  }
});

const res = await client.chat.completions.create({
  model: "qwen3-235b-instruct",
  messages: [{ role: "user", content: "Explain the repo in one paragraph." }],
  max_tokens: 512
});

console.log(res.choices[0]?.message?.content);
```

## Aider example

```bash
export OPENAI_API_BASE="https://YOUR_WORKER.workers.dev/v1"
export OPENAI_API_KEY="gooddollar-antseed"
# If Aider cannot set custom headers directly, run a local proxy that injects x-gooddollar-account.
aider --model openai/qwen3-235b-instruct
```

## Local Worker dev

For Worker development:

```bash
git clone https://github.com/GoodDollar/antseed-integration.git
cd antseed-integration/backend
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

For local testing without Celo tx receipts, use the manual endpoints:

```bash
curl -X POST "http://127.0.0.1:8787/v1/celo/deposits/manual" \
  -H "content-type: application/json" \
  -d '{
    "account":"0xYOUR_WALLET",
    "rootAccount":"0xYOUR_GOODID_ROOT",
    "gdAmountWei":"1000000000000000000",
    "source":"manual"
  }'
```

Then call:

```bash
curl "http://127.0.0.1:8787/v1/accounts/0xYOUR_WALLET/credit"
```

## Production setup checklist

A production deployment needs:

- deployed `CeloGdAntSeedVault`,
- Celo G$ token address,
- Celo G$ SuperToken address,
- GoodID verifier address,
- Superfluid Host address,
- Superfluid CFAv1 agreement address,
- Worker KV namespace IDs,
- `CELO_RPC_URL`,
- `CELO_VAULT_ADDRESS`,
- `CELO_GOODID_ADDRESS`,
- public `ANTSEED_BASE_URL`,
- optional AntSeed pinning headers/secrets.

## Safety and limitations

- Credits are not USDC balances; they are accounting credits for AntSeed usage.
- KV is durable but eventually consistent. On-chain vault events are the source of truth for deposits and stream updates.
- The current guide assumes the Worker endpoint is trusted by the user/tool. Add production auth/rate limits before public launch.
- A deployed Cloudflare Worker cannot reach `127.0.0.1`; production `ANTSEED_BASE_URL` must be public.
- Keep private keys out of `.dev.vars`, shell history, and git.
