# Payment Flow

This integration has two layers:

1. **GoodDollar user/credit layer** — GoodID auth, G$ deposits/streams, bonus accounting, API keys, and local developer-tool UX.
2. **AntSeed buyer payment layer** — the current AntSeed deposits contract and buyer-signed EIP-712 reserve/settle authorization that deducts from deposits.

The GoodDollar layer should not be treated as the final AntSeed payment primitive. It is the user-facing accounting and authorization layer in front of the current AntSeed buyer deposit flow.

## Current request path

```text
Developer tool
  -> GoodDollar AntSeed Worker /v1/chat/completions
  -> verified gd_live API key maps to wallet / GoodID root
  -> Worker checks and reserves the user's GoodDollar credit balance
  -> Worker forwards request through the configured AntSeed buyer gateway
  -> buyer signs the EIP-712 reserve/settle authorization
  -> AntSeed deposits contract deducts from the buyer/user deposit balance
  -> Worker settles/deducts GoodDollar credits and returns the model response
```

## What the Worker owns today

- Wallet-signature auth for issuing `gd_live_...` API keys.
- GoodID root resolution and aggregation.
- G$ deposit/stream event ingestion from Celo.
- Bonus credit calculation: regular +10%, streaming +20% up to monthly stream-speed cap.
- KV-backed user/request/credit accounting.
- Request-level reserve/release/settle lifecycle for the GoodDollar credit layer.
- Forwarding the model request to the AntSeed buyer gateway.

## What the AntSeed buyer/deposits layer owns today

- Actual network-side buyer funding.
- Deposits contract balance deductions.
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

Those future mechanisms should be added as adapters above the current deposit/EIP-712 layer, not by hiding the fact that today the production-ish payment path is deposit-backed.
