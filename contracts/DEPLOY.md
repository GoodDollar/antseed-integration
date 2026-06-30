# Contracts — Production Deployment

This guide covers deploying `CeloGdAntSeedVault` (Celo) and `AntseedBuyerOperator` (Base) to production using Foundry.

Run all commands from the **repository root** unless noted otherwise.

## Prerequisites

- [Foundry](https://getfoundry.sh/) installed (`forge`, `cast`)
- A funded deployer EOA on both Celo and Base
- RPC endpoints for Celo and Base (public or private node)
- API keys for block explorer verification (Celoscan / Basescan) — optional but recommended

```bash
# Verify Foundry is installed
forge --version
```

---

## 1. Build and test

```bash
forge build
forge test -vvv
```

All tests must pass before proceeding.

---

## 2. Prepare environment variables

Create a file named `.env` in the repo root (never commit this file):

```bash
# Deployer
DEPLOYER_PRIVATE_KEY=0x<64-hex-chars>

# Shared
OWNER_ADDRESS=0x<multisig-or-owner-address>

# ── Celo (CeloGdAntSeedVault) ────────────────────────────────────────────────
GD_TOKEN=0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c14       # G$ ERC-20 on Celo mainnet
GD_SUPER_TOKEN=0x<gd-supertoken-celo>                      # G$ Superfluid SuperToken
SUPERFLUID_HOST=0x<superfluid-host-celo>                   # Superfluid Host on Celo
CFA_V1=0x<cfa-v1-celo>                                     # ConstantFlowAgreementV1 on Celo

# ── Base (AntseedBuyerOperator) ───────────────────────────────────────────────
ANTSEED_REGISTRY=0x<antseed-registry-base>                 # AntSeed Registry on Base

# ── RPC ──────────────────────────────────────────────────────────────────────
CELO_RPC_URL=https://forno.celo.org
BASE_RPC_URL=https://mainnet.base.org

# ── Block explorer API keys (optional, for --verify) ─────────────────────────
CELOSCAN_API_KEY=<your-celoscan-api-key>
BASESCAN_API_KEY=<your-basescan-api-key>
```

Load the variables into your shell:

```bash
set -a && source .env && set +a
```

> **Security:** Never expose `DEPLOYER_PRIVATE_KEY` in CI logs or public repositories. Use a hardware wallet or secrets manager in automated pipelines.

---

## 3. Deploy `CeloGdAntSeedVault` on Celo

```bash
forge script contracts/script/Deploy.s.sol:Deploy \
  --rpc-url "$CELO_RPC_URL" \
  --broadcast \
  --verify \
  --etherscan-api-key "$CELOSCAN_API_KEY" \
  -vvvv
```

On success, Foundry writes proxy and implementation addresses to `deploy-output.json`:

```json
{
  "vaultImplementation": "0x…",
  "vaultProxy": "0x…",
  "operatorImplementation": "0x…",
  "operatorProxy": "0x…"
}
```

> **Note:** The deploy script deploys **both** contracts. Because `CeloGdAntSeedVault` is a Celo contract and `AntseedBuyerOperator` is a Base contract, the script currently targets one chain at a time. Deploy each separately if your RPC endpoints differ (see step 4).

Record the `vaultProxy` address — you will need it in the Worker configuration.

---

## 4. Deploy `AntseedBuyerOperator` on Base

If you need to deploy only the Base operator (e.g., the vault is already live on Celo), run:

```bash
forge script contracts/script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_RPC_URL" \
  --broadcast \
  --verify \
  --etherscan-api-key "$BASESCAN_API_KEY" \
  -vvvv
```

Record the `operatorProxy` address.

---

## 5. Post-deployment configuration

### 5.1 Fund the operator wallet with USDC (Base)

The `AntseedBuyerOperator` calls `IAntseedDeposits.deposit` on behalf of buyers. The operator wallet must hold (or be pre-approved for) sufficient USDC on Base.

```bash
# Check operator USDC balance
cast call <usdc-address-base> "balanceOf(address)(uint256)" <operator-wallet>
```

### 5.2 Set the operator `admin` (optional)

By default the deployer `owner` is the admin. To designate a separate hot-wallet admin:

```bash
cast send <operatorProxy> "setAdmin(address)" <admin-address> \
  --rpc-url "$BASE_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY"
```

### 5.3 Update the backend Worker config

Edit `backend/wrangler.toml` and set `CELO_VAULT_ADDRESS` to the `vaultProxy` address from `deploy-output.json`. Then set the Base operator secrets (see `backend/DEPLOY.md`, step 3):

```bash
cd backend
npx wrangler secret put ANTSEED_FUNDING_VAULT_ADDRESS
# Prompt: operatorProxy address from deploy-output.json

npx wrangler secret put ANTSEED_FUNDING_RPC_URL
# Prompt: Base RPC URL

npx wrangler secret put ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY
# Prompt: operator wallet private key
```

---

## 6. Verify deployed contracts

```bash
# Check vault owner on Celo
cast call <vaultProxy-celo> "owner()(address)" --rpc-url "$CELO_RPC_URL"

# Check operator owner on Base
cast call <operatorProxy-base> "owner()(address)" --rpc-url "$BASE_RPC_URL"

# Confirm proxy implementation slot (ERC-1967)
cast storage <vaultProxy-celo> \
  0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc \
  --rpc-url "$CELO_RPC_URL"
```

---

## Upgrading contracts (UUPS)

Both contracts use UUPS proxies. To upgrade:

1. Implement the new logic contract (must inherit the existing storage layout).
2. Deploy the new implementation:

```bash
forge create contracts/src/CeloGdAntSeedVault.sol:CeloGdAntSeedVault \
  --rpc-url "$CELO_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --constructor-args <gdToken> <gdSuperToken>
```

3. Call `upgradeToAndCall` from the owner:

```bash
cast send <vaultProxy> \
  "upgradeToAndCall(address,bytes)" <newImpl> 0x \
  --rpc-url "$CELO_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY"
```

4. Run `forge test -vvv` against a fork to validate before upgrading on mainnet:

```bash
forge test -vvv --fork-url "$CELO_RPC_URL"
```

---

## Useful `cast` commands

```bash
# Decode a transaction
cast tx <txHash> --rpc-url "$CELO_RPC_URL"

# Get event logs from the vault
cast logs --from-block <block> --address <vaultProxy> --rpc-url "$CELO_RPC_URL"

# Check if a deposit ID has been used (anti-double-fund guard)
cast call <operatorProxy> \
  "usedDepositIds(bytes32)(bool)" <keccak256-of-entry-id> \
  --rpc-url "$BASE_RPC_URL"
```
