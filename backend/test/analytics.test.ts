import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { readAnalytics, refreshAnalytics } from "../src/analytics.js";
import { configFromEnv, Env } from "../src/env.js";

class MemoryKV {
  private data = new Map<string, string>();

  async get(key: string, type?: "text" | "json") {
    const raw = this.data.get(key) ?? null;
    if (type === "json") return raw ? JSON.parse(raw) : null;
    return raw;
  }

  async put(key: string, value: string) {
    this.data.set(key, value);
  }
}

const CELO_EVENTS = new Interface([
  "event GdDeposited(address indexed account,address indexed buyer,uint256 gdAmount,bytes data)",
  "event StreamUpdated(address indexed account,address indexed buyer,int96 flowRate,uint256 monthlyGdAmountWei,uint256 totalFlowWei)"
]);

const CHANNEL_CALLS = new Interface([
  "function settle(bytes32 channelId, uint128 cumulativeAmount, bytes metadata, bytes buyerSig)"
]);
const DEPOSIT_EVENT = CELO_EVENTS.getEvent("GdDeposited");
const STREAM_EVENT = CELO_EVENTS.getEvent("StreamUpdated");

test("refreshAnalytics aggregates Celo and Base metrics and stores readable snapshots", async () => {
  const kv = new MemoryKV();
  const celoVault = "0x0000000000000000000000000000000000000def";
  const baseChannels = "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d";
  const account = "0x0000000000000000000000000000000000000abc";
  const buyer = "0x0000000000000000000000000000000000000aaa";
  if (!DEPOSIT_EVENT || !STREAM_EVENT) throw new Error("test event ABI missing");

  const depositEvent = CELO_EVENTS.encodeEventLog(DEPOSIT_EVENT, [account, buyer, 100n, "0x"]);
  const streamEvent = CELO_EVENTS.encodeEventLog(STREAM_EVENT, [account, buyer, 2n, 5n, 5n]);

  const settleInput = CHANNEL_CALLS.encodeFunctionData("settle", [
    `0x${"1".repeat(64)}`,
    10n,
    "0x",
    "0x"
  ]);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).includes("celo")) {
        if (body.method === "eth_blockNumber") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x11" });
        if (body.method === "eth_getLogs") {
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: [
              {
                address: celoVault,
                topics: depositEvent.topics,
                data: depositEvent.data,
                blockNumber: "0x10",
                transactionHash: `0x${"2".repeat(64)}`,
                logIndex: "0x0"
              },
              {
                address: celoVault,
                topics: streamEvent.topics,
                data: streamEvent.data,
                blockNumber: "0x11",
                transactionHash: `0x${"3".repeat(64)}`,
                logIndex: "0x0"
              }
            ]
          });
        }
        if (body.method === "eth_getBlockByNumber") {
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: { timestamp: "0x6a620240" }
          });
        }
      }

      if (String(url).includes("base")) {
        if (body.method === "eth_blockNumber") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x21" });
        if (body.method === "eth_getLogs") {
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: [
              {
                address: baseChannels,
                topics: ["0x01"],
                data: "0x",
                blockNumber: "0x21",
                transactionHash: `0x${"4".repeat(64)}`,
                logIndex: "0x0"
              }
            ]
          });
        }
        if (body.method === "eth_getTransactionByHash") {
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              from: buyer,
              input: settleInput
            }
          });
        }
        if (body.method === "eth_getBlockByNumber") {
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: { timestamp: "0x6a620240" }
          });
        }
      }

      throw new Error(`unexpected rpc call: ${body.method} ${String(url)}`);
    }) as typeof fetch;

    const testEnv = {
      ANTSEED_KV: kv,
      CELO_RPC_URL: "https://celo.rpc.local",
      CELO_VAULT_ADDRESS: celoVault,
      ANTSEED_FUNDING_RPC_URL: "https://base.rpc.local",
      BASE_CHANNELS_ADDRESS: baseChannels,
      ANALYTICS_REFRESH_INTERVAL_SECONDS: "21600"
    } as unknown as Env;

    const cfg = configFromEnv(testEnv);
    const runAt = new Date("2026-07-23T12:00:00.000Z");

    const refreshed = await refreshAnalytics(testEnv, cfg, runAt);
    assert.equal(refreshed.refreshed, true);
    assert.equal(refreshed.celoProcessed, 2);
    assert.equal(refreshed.baseProcessed, 1);

    const snapshot = await readAnalytics(kv as never, 1, runAt);
    assert.equal(snapshot.daily.length, 1);
    assert.equal(snapshot.daily[0].date, "2026-07-23");
    assert.equal(snapshot.daily[0].gdOneTimeDeposits, "100");
    assert.equal(snapshot.daily[0].gdStreamed, "5");
    assert.equal(snapshot.daily[0].gdTotalFlowRate, "2");
    assert.equal(snapshot.daily[0].aiCreditsUsed, "10");
    assert.equal(snapshot.daily[0].uniqueGdBuyers, 1);
    assert.equal(snapshot.daily[0].uniqueCreditUsers, 1);

    assert.equal(snapshot.global.gdOneTimeDeposits, "100");
    assert.equal(snapshot.global.gdStreamed, "5");
    assert.equal(snapshot.global.gdTotalFlowRate, "2");
    assert.equal(snapshot.global.aiCreditsUsed, "10");
    assert.equal(snapshot.lastRun.celoLastBlock, "17");
    assert.equal(snapshot.lastRun.baseLastBlock, "33");

    const secondRun = await refreshAnalytics(testEnv, cfg, new Date("2026-07-23T19:00:00.000Z"));
    assert.equal(secondRun.refreshed, true);
    const secondSnapshot = await readAnalytics(kv as never, 1, runAt);
    assert.equal(secondSnapshot.global.gdOneTimeDeposits, "100");
    assert.equal(secondSnapshot.global.aiCreditsUsed, "10");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
