# Backend Worker — Production Deployment

This guide covers deploying the Cloudflare Worker to production. Run all commands from the `backend/` directory.

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) authenticated to your Cloudflare account
- A deployed `CeloGdAntSeedVault` proxy address on Celo (see `contracts/DEPLOY.md`)
- A deployed `AntseedBuyerOperator` proxy address on Base (see `contracts/DEPLOY.md`)
- An operator wallet private key with sufficient USDC approved to `AntseedBuyerOperator`

```bash
# Authenticate once
npx wrangler login
```

---

## 1. Install dependencies and verify

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

All checks must pass before deploying.

---

## 2. Create the KV namespace (first deployment only)

The Worker requires a KV namespace bound as `ANTSEED_KV`.

```bash
# Create the namespace and note the returned id
npx wrangler kv namespace create ANTSEED_KV
```

Edit `wrangler.toml` and set the returned `id` under `[[kv_namespaces]]`:

```toml
[[kv_namespaces]]
binding = "ANTSEED_KV"
id = "<id-from-above>"
```

---

## 3. Set secrets (sensitive values)

Secrets are stored encrypted in Cloudflare and never appear in `wrangler.toml`.

```bash
npx wrangler secret put ANTSEED_FUNDING_RPC_URL
# Prompt: Base RPC URL (e.g. https://mainnet.base.org or a private node)

npx wrangler secret put ANTSEED_FUNDING_VAULT_ADDRESS
# Prompt: AntseedBuyerOperator proxy address on Base

npx wrangler secret put ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY
# Prompt: private key of the operator wallet on Base (hex, 0x-prefixed)
```

---

## 4. Configure public vars in `wrangler.toml`

Update the `[vars]` section with production values:

| Variable | Description | Example |
|---|---|---|
| `CELO_RPC_URL` | Celo JSON-RPC endpoint | `https://forno.celo.org` |
| `CELO_VAULT_ADDRESS` | `CeloGdAntSeedVault` proxy address on Celo | `0x…` |
| `CELO_GOODID_ADDRESS` | GoodID root resolver on Celo | `0xC361A6E67822a0EDc17D899227dd9FC50BD62F42` |
| `CELO_STATIC_ORACLE_ADDRESS` | Celo static price oracle | `0x00851A91a3c4E9a4c1B48df827Bacc1f884bdE28` |
| `CELO_CUSD_ADDRESS` | cUSD ERC-20 on Celo | `0x765DE816845861e75A25fCA122bb6898B8B1282a` |
| `CELO_GD_SUPERTOKEN_ADDRESS` | G$ SuperToken (Superfluid) on Celo | `0x…` |
| `SUPERFLUID_SUBGRAPH_URL` | Superfluid subgraph endpoint for stream data | `https://…` |
| `GD_CUSD_PRICE` | Current G$/cUSD exchange rate (decimal) | `0.001154` |
| `MAX_BONUS_CAP_USD` | Monthly per-root bonus cap in micro-USD | `100000000` (= $100) |

> **Note:** `GD_CUSD_PRICE` should be updated whenever the G$ price drifts significantly. A future cron-based price update is planned.

---

## 5. Deploy

```bash
npx wrangler deploy
```

Wrangler prints the Worker URL on success. The cron trigger (`* * * * *`) is activated automatically.

---

## 6. Verify the deployment

```bash
# Health check
curl https://<worker-subdomain>.workers.dev/health

# Config status (shows which optional features are enabled)
curl https://<worker-subdomain>.workers.dev/config/status
```

Expected `/health` response: `{"status":"ok"}`

Expected `/config/status` fields:
- `fundingEnabled: true` — operator private key and vault address are set
- `celoVaultConfigured: true` — Celo vault address is set

---

## 7. Custom domain (optional)

To serve the Worker under your own domain:

```bash
npx wrangler deploy --route "api.example.com/v1/*"
```

Or configure a custom domain in the Cloudflare dashboard under **Workers & Pages → your worker → Settings → Domains & Routes**.

---

## Updating secrets or vars

```bash
# Update a secret
npx wrangler secret put ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY

# Update a var — edit wrangler.toml then redeploy
npx wrangler deploy
```

---

## Rollback

Cloudflare retains the previous Worker version. Roll back in the dashboard under **Workers & Pages → your worker → Deployments**, or redeploy the last known-good Git commit:

```bash
git checkout <commit>
npm ci && npm run build
npx wrangler deploy
```

---

## Useful Wrangler commands

```bash
# View live logs
npx wrangler tail

# List KV keys
npx wrangler kv key list --namespace-id <id>

# Read a KV value
npx wrangler kv key get --namespace-id <id> "<key>"

# Trigger the cron handler manually (local)
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```
