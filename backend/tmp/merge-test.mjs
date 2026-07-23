import { AnalyticsClient } from "../src/analytics.js";

const kv = new Map();
const kvns = {
  get: async (k, t) => { const v = kv.get(k); if (t === "json") return v ? JSON.parse(v) : null; return v ?? null; },
  put: async (k, v) => kv.set(k, v),
  list: async () => ({ keys: Array.from(kv.keys()).map((name) => ({ name })), list_complete: true })
};

const cfg = { CELO_RPC_URL: "x", CELO_VAULT_ADDRESS: "0x0000000000000000000000000000000000000def" };
const client = new AnalyticsClient({ kv: kvns, cfg });
const update = {
  date: "2025-08-24",
  gdOneTimeDeposits: "2000",
  gdStreamed: "0",
  gdTotalFlowRate: "100",
  aiCreditsUsed: "0",
  uniqueGdBuyers: 1,
  uniqueCreditUsers: 0
};
await client["mergeDailyRecord"]("2025-08-24", update);
await client["updateGlobalTotals"]();
console.log("kv", Array.from(kv.entries()));
