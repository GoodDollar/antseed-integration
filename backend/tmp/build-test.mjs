import { AnalyticsClient } from "../src/analytics.js";

const kv = new Map();
const kvns = {
  get: async (k, t) => { const v = kv.get(k); if (t === "json") return v ? JSON.parse(v) : null; return v ?? null; },
  put: async (k, v) => kv.set(k, v)
};

const cfg = { CELO_RPC_URL: "x", CELO_VAULT_ADDRESS: "0x0000000000000000000000000000000000000def" };
const client = new AnalyticsClient({ kv: kvns, cfg });
const events = [{ kind: "deposit", buyer: "0xaaa", gdAmountWei: 2000n, blockNumber: 1000 }];
const timestamps = new Map();
timestamps.set(1000, 1756000000);
const updates = client["buildDailyUpdates"](events, [], timestamps, 100n);
console.log(updates);
