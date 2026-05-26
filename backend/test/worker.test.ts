import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { AntSeedFundingVaultClient } from "../src/antseed-funding-vault.js";
import { Env } from "../src/env.js";

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
    CELO_EVENTS_API_KEY: "test-api-key",
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

test("manual Celo credit records and attempts buyer-operator deposit for same user", async () => {
  const original = AntSeedFundingVaultClient.prototype.depositForBuyer;
  let capturedBuyer: string | undefined;
  let capturedAmount: bigint | undefined;

  AntSeedFundingVaultClient.prototype.depositForBuyer = async function (buyer: string, amountMicroUsd: bigint) {
    capturedBuyer = buyer;
    capturedAmount = amountMicroUsd;
    return { enabled: false, buyer, amountMicroUsd: amountMicroUsd.toString() };
  };

  try {
    const account = "0x0000000000000000000000000000000000000abc";
    const txHash = "0x" + "12".repeat(32);
    const res = await worker.fetch(new Request("https://worker.test/v1/celo/deposits/manual", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-api-key" },
      body: JSON.stringify({ account, gdAmountWei: "1000000000000000000", source: "manual", txHash, logIndex: 1 })
    }), env(), {} as ExecutionContext);

    assert.equal(res.status, 200);
    const body = await res.json() as { account: string; totalCreditMicroUsd: string; bridge: { enabled: boolean; buyer: string; amountMicroUsd: string } };
    assert.equal(body.account, account);
    assert.equal(body.bridge.enabled, false);
    assert.equal(body.bridge.buyer, account);
    assert.equal(body.bridge.amountMicroUsd, body.totalCreditMicroUsd);
    assert.equal(capturedBuyer, account);
    assert.equal(capturedAmount?.toString(), body.totalCreditMicroUsd);
  } finally {
    AntSeedFundingVaultClient.prototype.depositForBuyer = original;
  }
});

test("manual Celo deposit endpoint requires API key auth", async () => {
  const account = "0x0000000000000000000000000000000000000abc";
  const txHash = "0x" + "34".repeat(32);
  const res = await worker.fetch(new Request("https://worker.test/v1/celo/deposits/manual", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account, gdAmountWei: "1000000000000000000", source: "manual", txHash, logIndex: 1 })
  }), env(), {} as ExecutionContext);
  assert.equal(res.status, 401);
});

test("manual Celo deposit retries do not duplicate bridge deposits", async () => {
  const original = AntSeedFundingVaultClient.prototype.depositForBuyer;
  let bridgeCalls = 0;

  AntSeedFundingVaultClient.prototype.depositForBuyer = async function (buyer: string, amountMicroUsd: bigint) {
    bridgeCalls += 1;
    return {
      enabled: true,
      buyer,
      amountMicroUsd: amountMicroUsd.toString(),
      txHash: "0x" + bridgeCalls.toString(16).padStart(64, "0")
    };
  };

  try {
    const workerEnv = env();
    const account = "0x0000000000000000000000000000000000000abc";
    const txHash = "0x" + "56".repeat(32);
    const requestBody = JSON.stringify({ account, gdAmountWei: "1000000000000000000", source: "manual", txHash, logIndex: 9 });
    const headers = { "content-type": "application/json", "x-api-key": "test-api-key" };

    const first = await worker.fetch(new Request("https://worker.test/v1/celo/deposits/manual", {
      method: "POST",
      headers,
      body: requestBody
    }), workerEnv, {} as ExecutionContext);
    assert.equal(first.status, 200);

    const second = await worker.fetch(new Request("https://worker.test/v1/celo/deposits/manual", {
      method: "POST",
      headers,
      body: requestBody
    }), workerEnv, {} as ExecutionContext);
    assert.equal(second.status, 200);
    assert.equal(bridgeCalls, 1);

    const secondBody = await second.json() as { bridge: { skipped?: boolean; reason?: string } };
    assert.equal(secondBody.bridge.skipped, true);
    assert.equal(secondBody.bridge.reason, "duplicate-event");
  } finally {
    AntSeedFundingVaultClient.prototype.depositForBuyer = original;
  }
});
