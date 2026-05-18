# GoodDollar AntSeed Credits User Guide

Use G$ on Celo to buy AntSeed AI compute credits, then point your **local developer tools** at the GoodDollar AntSeed API.

This is an end-user setup guide. You do **not** need to clone or contribute to this repository to use AntSeed from VS Code, local coding agents, or OpenAI-compatible clients.

## Quick mental model

```text
G$ on Celo -> CeloGdAntSeedVault -> Worker verifies tx -> credit balance -> AntSeed AI models -> your local dev tool
```

- You deposit or stream G$ to the Celo vault.
- The Worker verifies the vault transaction on Celo.
- Your credits are recorded by wallet address and by your GoodID root wallet.
- Your developer tool calls the Worker as an OpenAI-compatible AI endpoint.
- The Worker reserves credits, forwards your prompt to AntSeed, then settles actual usage.

## What you need

Ask the GoodDollar/AntSeed operator for these production values:

```bash
export GOODDOLLAR_ANTSEED_API="https://YOUR_GOODDOLLAR_ANTSEED_WORKER"
export GOODDOLLAR_ACCOUNT="0xYOUR_GOODID_WALLET"
export GOODDOLLAR_ANTSEED_MODEL="qwen3-235b-instruct"
```

Check that the API is alive:

```bash
curl "$GOODDOLLAR_ANTSEED_API/health"
curl "$GOODDOLLAR_ANTSEED_API/config/status"
```

`/config/status` shows the OpenAI-compatible path, configured model, Celo integration flags, and supported account selector formats.

## Why use G$ credits instead of paying USDC directly?

Plain USDC payment is simple: pay $1, receive roughly $1 of compute.

GoodDollar AntSeed credits add a GoodDollar-native credit layer:

1. **Bonus credits**
   - One-time G$ deposits receive **+10%** credits.
   - Active G$ streamers receive **+20%** credits up to their monthly stream-speed cap.

2. **GoodID-gated access**
   - Deposits and stream creation require a GoodID-verified wallet.
   - Connected wallets are aggregated under `getWhitelistedRoot(account)`, so linked wallets can share a user-level credit history.

3. **Monthly stream budget**
   - You can stream G$ monthly instead of topping up manually.
   - Example: if your stream speed equals `$1/month` worth of G$, up to `$1` of monthly principal receives `$1.20` of credits. Additional principal receives `$1.10` per `$1`.

4. **On-chain proof of funding**
   - Credits come from Celo vault events, not a centralized off-chain payment button.
   - The Worker records credit only after verifying vault events.

5. **Developer-tool UX**
   - After credits are recorded, local tools can use AntSeed through normal AI API settings: base URL, model, and API key.

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

The exact G$ -> USD conversion depends on the Worker’s configured `GD_MICRO_USD_PER_TOKEN` until a production oracle/quote path is wired.

## Step 1 — Make sure your wallet has GoodID

Your deposit wallet must be GoodID verified.

The vault accepts either:

- `isWhitelisted(account) == true`, or
- `getWhitelistedRoot(account) != address(0)`

The Worker also uses `getWhitelistedRoot(account)` to maintain an additional aggregate credit record for your GoodID root wallet.

## Step 2 — Buy AntSeed credits with G$

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

## Step 3 — Stream G$ for the monthly credit boost

If you stream G$ to the Celo vault through Superfluid, the vault reacts as a SuperApp receiver.

Create or update a Constant Flow Agreement from your wallet to the vault using the G$ SuperToken on Celo.

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
curl "$GOODDOLLAR_ANTSEED_API/v1/accounts/$GOODDOLLAR_ACCOUNT/credit"
```

The response includes:

- wallet-level profile,
- GoodID-root aggregate profile when applicable,
- G$ credit entries,
- AntSeed request history,
- current stream cap,
- available credit balance.

## Step 5 — Connect local developer tools to AntSeed

The Worker exposes an OpenAI-compatible chat-completions endpoint:

```text
POST /v1/chat/completions
```

Use these values in tools that support OpenAI-compatible providers:

```bash
Base URL:  $GOODDOLLAR_ANTSEED_API/v1
Model:     qwen3-235b-instruct
API key:   gd:0xYOUR_GOODID_WALLET
```

The `gd:0x...` API key is an **account selector**, not a private key and not a wallet signature. It lets standard tools identify which GoodDollar credit balance to charge through the normal `Authorization: Bearer ...` header.

The Worker accepts any of these account selectors:

```text
Authorization: Bearer gd:0xYOUR_GOODID_WALLET
Authorization: Bearer account:0xYOUR_GOODID_WALLET
x-gooddollar-account: 0xYOUR_GOODID_WALLET
JSON body field: "account": "0xYOUR_GOODID_WALLET"
```

### Quick inference test

```bash
curl "$GOODDOLLAR_ANTSEED_API/v1/chat/completions" \
  -H "content-type: application/json" \
  -H "authorization: Bearer gd:$GOODDOLLAR_ACCOUNT" \
  -d '{
    "model": "qwen3-235b-instruct",
    "messages": [
      { "role": "user", "content": "Reply with one sentence about GoodDollar." }
    ],
    "max_tokens": 128
  }'
```

If your tool supports custom headers, you can also set:

```text
x-gooddollar-account: 0xYOUR_GOODID_WALLET
```

But the `gd:0x...` API-key pattern is usually easier because most tools already support an OpenAI API key field.

## VS Code setup

### Continue extension

In `~/.continue/config.json`, add an OpenAI-compatible model:

```json
{
  "models": [
    {
      "title": "GoodDollar AntSeed",
      "provider": "openai",
      "model": "qwen3-235b-instruct",
      "apiBase": "https://YOUR_GOODDOLLAR_ANTSEED_WORKER/v1",
      "apiKey": "gd:0xYOUR_GOODID_WALLET"
    }
  ]
}
```

Then select **GoodDollar AntSeed** inside Continue.

### Cline / Roo Code / other VS Code agents

Use the tool’s OpenAI-compatible provider settings:

```text
Provider:  OpenAI Compatible
Base URL:  https://YOUR_GOODDOLLAR_ANTSEED_WORKER/v1
API key:   gd:0xYOUR_GOODID_WALLET
Model:     qwen3-235b-instruct
```

If the tool has a separate “custom headers” field, you may instead set:

```text
x-gooddollar-account: 0xYOUR_GOODID_WALLET
```

## Aider setup

```bash
export OPENAI_API_BASE="$GOODDOLLAR_ANTSEED_API/v1"
export OPENAI_API_KEY="gd:$GOODDOLLAR_ACCOUNT"
aider --model openai/qwen3-235b-instruct
```

## OpenAI SDK setup

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "gd:0xYOUR_GOODID_WALLET",
  baseURL: "https://YOUR_GOODDOLLAR_ANTSEED_WORKER/v1"
});

const res = await client.chat.completions.create({
  model: "qwen3-235b-instruct",
  messages: [{ role: "user", content: "Explain this codebase in one paragraph." }],
  max_tokens: 512
});

console.log(res.choices[0]?.message?.content);
```

## Claude Code setup

Claude Code is Anthropic-native, while this Worker currently exposes an OpenAI-compatible `/v1/chat/completions` API.

So for Claude Code specifically, do **not** clone this integration repo for “local setup.” Instead use one of these routes:

1. **Use a GoodDollar AntSeed Anthropic-compatible gateway** if the operator exposes one.
   - Configure Claude Code to point at that gateway.
   - The gateway should translate Anthropic Messages requests to the Worker’s OpenAI-compatible chat-completions endpoint and charge credits using `gd:0xYOUR_GOODID_WALLET` or `x-gooddollar-account`.

2. **Use an OpenAI-compatible coding agent instead** for direct access today.
   - Continue, Cline, Roo Code, Aider, OpenClaw, and many local agents can use the Worker directly with `Base URL = .../v1` and `API key = gd:0x...`.

3. **Run a local compatibility proxy** only if you already have one.
   - Upstream target: `POST $GOODDOLLAR_ANTSEED_API/v1/chat/completions`
   - Upstream auth header: `Authorization: Bearer gd:0xYOUR_GOODID_WALLET`
   - Upstream model: `qwen3-235b-instruct`

Until a first-class `/v1/messages` compatibility endpoint exists, native Claude Code direct configuration is not the primary path.

## Troubleshooting

### Check API configuration

```bash
curl "$GOODDOLLAR_ANTSEED_API/config/status"
```

Look for:

- `openAiCompatible.chatCompletionsPath = /v1/chat/completions`
- `antseed.model`
- `celo.vaultConfigured = true`
- `celo.goodIdConfigured = true`

### Check credits

```bash
curl "$GOODDOLLAR_ANTSEED_API/v1/accounts/$GOODDOLLAR_ACCOUNT/credit"
```

If you see an insufficient credit error, deposit or stream more G$ and record the Celo transaction hash again.

### Tool cannot set custom headers

Use the API key pattern:

```text
gd:0xYOUR_GOODID_WALLET
```

Most OpenAI-compatible tools will send that as:

```text
Authorization: Bearer gd:0xYOUR_GOODID_WALLET
```

### Tool wants a model list endpoint

This Worker currently supports chat completions. If a tool requires `/v1/models`, either configure the model manually or add a tiny local proxy that returns a static model list.

## Safety and limitations

- Credits are not USDC balances; they are accounting credits for AntSeed usage.
- `gd:0x...` identifies the account to charge. It is not a wallet signature and should be replaced by signed auth or real API keys before a broad public launch.
- KV is durable but eventually consistent. On-chain vault events are the source of truth for deposits and stream updates.
- A deployed Cloudflare Worker cannot reach `127.0.0.1`; production `ANTSEED_BASE_URL` must be publicly reachable.
- Never put wallet private keys or seed phrases into developer-tool model settings.
