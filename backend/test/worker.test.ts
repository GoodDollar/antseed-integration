import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { Env } from "../src/env.js";
import { encodeVaultEventLog } from "../src/celo-events.js";

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

function env(overrides: Partial<Env> = {}): Env {
  return {
    ANTSEED_KV: new MemoryKV() as never,
    ...overrides
  } as Env;
}

test("health exposes bridge status", async () => {
  const res = await worker.fetch(new Request("https://worker.test/health"), env(), {} as ExecutionContext);
  assert.equal(res.status, 200);
  const body = await res.json() as { bridgeEnabled: boolean };
  assert.equal(body.bridgeEnabled, false);
});

test("config status documents celo-to-base bridge mode", async () => {
  const res = await worker.fetch(new Request("https://worker.test/config/status"), env(), {} as ExecutionContext);
  assert.equal(res.status, 200);
  const body = await res.json() as {
    bridge: { celoVaultEvents: boolean; baseBuyerOperatorEnabled: boolean; mode: string };
  };
  assert.equal(body.bridge.celoVaultEvents, true);
  assert.equal(body.bridge.baseBuyerOperatorEnabled, false);
  assert.equal(body.bridge.mode, "celo-vault-to-base-buyer-operator");
});

test("/v1/celo/events/record settles prorated stream bonus and correlates IDs", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const txHash = `0x${"2".repeat(64)}`;
  const celoVault = "0x0000000000000000000000000000000000000def";
  const flowRate = "1157407407407"; // ~3 G$ / month

  const now = Date.now;
  const originalFetch = globalThis.fetch;

  try {
    Date.now = () => 0;
    const testEnv = env({ CELO_RPC_URL: "https://celo.rpc.local", CELO_VAULT_ADDRESS: celoVault });

    const streamStartRes = await worker.fetch(new Request("https://worker.test/v1/celo/streams/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account, flowRateWeiPerSecond: flowRate, monthlyGdAmountWei: "3000000000000000000" })
    }), testEnv, {} as ExecutionContext);
    assert.equal(streamStartRes.status, 200);

    const stopLog = encodeVaultEventLog(
      "StreamUpdated",
      [account, 0n, 0n, 0n],
      celoVault,
      txHash,
      0
    );

    Date.now = () => 15 * 24 * 60 * 60 * 1000;
    globalThis.fetch = (async () => {
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { logs: [stopLog] }
      });
    }) as typeof fetch;

    const res = await worker.fetch(new Request("https://worker.test/v1/celo/events/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash })
    }), testEnv, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ settledStreamBonusCreditId?: string }> };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].settledStreamBonusCreditId, `${txHash}:0`);

    const creditRes = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/credit`), testEnv, {} as ExecutionContext);
    assert.equal(creditRes.status, 200);
    const creditBody = await creditRes.json() as { gdCredits: Array<{ id: string; source: string; fundingId?: string }> };
    const streamBonus = creditBody.gdCredits.find((entry) => entry.id === `${txHash}:0`);
    assert.ok(streamBonus);
    assert.equal(streamBonus.source, "stream");
    assert.equal(streamBonus.fundingId, `${txHash}:0`);
  } finally {
    Date.now = now;
    globalThis.fetch = originalFetch;
  }
});
