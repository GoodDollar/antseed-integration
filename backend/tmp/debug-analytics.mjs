import { AnalyticsClient } from "../src/analytics.js";
import { Interface, encodeBytes32String } from "ethers";

const kv = new Map();

const vault = "0x0000000000000000000000000000000000000def";
const channels = "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d";
const buyerA = "0x0000000000000000000000000000000000000aaa";
const buyerB = "0x0000000000000000000000000000000000000bbb";
const account = "0x0000000000000000000000000000000000000abc";

const depositEvent = new Interface(["event GdDeposited(address indexed account,address indexed buyer,uint256 gdAmount,bytes data)"]);
const e1 = depositEvent.encodeEventLog(depositEvent.getEvent("GdDeposited"), [account, buyerA, 2000000000000000000n, "0x"]);

const chanAbi = new Interface(["event ChannelSettled(bytes32 indexed channelId, address indexed buyer, uint256 settledAmount)"]);
const e2 = chanAbi.encodeEventLog(chanAbi.getEvent("ChannelSettled"), [encodeBytes32String("chan1"), buyerB, 500000n]);

const celoLogs = [{ address: vault, topics: e1.topics, data: e1.data, blockNumber: 1000 }];
const baseLogs = [{ address: channels, topics: e2.topics, data: e2.data, blockNumber: 5000 }];

const testFetch = async (input, init) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (body?.method === "eth_blockNumber") return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x" + (url.includes("celo") ? 1000 : 5000).toString(16) });
  if (body?.method === "eth_getBlockByNumber") {
    const n = Number(body.params[0]);
    const ts = n === 1000 ? 1756000000 : n === 5000 ? 1756000100 : undefined;
    return Response.json({ jsonrpc: "2.0", id: body.id, result: ts ? { timestamp: "0x" + ts.toString(16) } : null });
  }
  if (body?.method === "eth_getLogs") return Response.json({ jsonrpc: "2.0", id: body.id, result: url.includes("celo") ? celoLogs : baseLogs });
  if (body?.query) return Response.json({ data: { streams: [{ currentFlowRate: "1000000000000000" }] } });
  return new Response("not found", { status: 404 });
};

const kvns = {
  get: async (k, t) => { const v = kv.get(k); if (t === "json") return v ? JSON.parse(v) : null; return v ?? null; },
  put: async (k, v) => kv.set(k, v),
  list: async () => ({ keys: Array.from(kv.keys()).map((name) => ({ name })), list_complete: true })
};

const cfg = {
  GD_CUSD_PRICE: 0.0001,
  MAX_BONUS_CAP_USD: 100n * 10n ** 18n,
  REGULAR_BONUS_BPS: 1000n,
  STREAMING_BONUS_BPS: 2000n,
  MIN_STREAM_BONUS_WEI: 4000n * 10n ** 18n,
  CELO_RPC_URL: "https://celo.rpc.local",
  CELO_VAULT_ADDRESS: vault,
  CELO_GD_SUPERTOKEN_ADDRESS: "0x0000000000000000000000000000000000000fed",
  SUPERFLUID_SUBGRAPH_URL: "https://superfluid.local/subgraph",
  BASE_RPC_URL: "https://base.rpc.local",
  ANTSEED_CHANNELS_ADDRESS: channels
};

async function main() {
  const client = new AnalyticsClient({ kv: kvns, cfg, fetch: testFetch });
  await client.runAggregation();
  const a = await client.getAnalytics(365);
  console.log("days count", a.days.length);
  console.log("global", a.global);
  console.log("kv keys", Array.from(kv.keys()));
  const day = a.days.find((d) => d.date === "2025-08-24");
  console.log("target day", day);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
