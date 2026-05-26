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
  const original = AntSeedFundingVaultClient.prototype.depositForBuyerWithId;
  let capturedBuyer: string | undefined;
  let capturedAmount: bigint | undefined;
  let capturedId: string | undefined;

  AntSeedFundingVaultClient.prototype.depositForBuyerWithId = async function (buyer: string, amountMicroUsd: bigint, id: string) {
    capturedBuyer = buyer;
    capturedAmount = amountMicroUsd;
    capturedId = id;
    return { enabled: false, buyer, amountMicroUsd: amountMicroUsd.toString() };
  };

  try {
    const account = "0x0000000000000000000000000000000000000abc";
    const res = await worker.fetch(new Request("https://worker.test/v1/celo/deposits/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account, gdAmountWei: "1000000000000000000", source: "manual", txHash: "0x" + "1".repeat(64), logIndex: 0 })
    }), env(), {} as ExecutionContext);

    assert.equal(res.status, 200);
    const body = await res.json() as { account: string; totalCreditMicroUsd: string; bridge: { enabled: boolean; buyer: string; amountMicroUsd: string } };
    assert.equal(body.account, account);
    assert.equal(body.bridge.enabled, false);
    assert.equal(body.bridge.buyer, account);
    assert.equal(body.bridge.amountMicroUsd, body.totalCreditMicroUsd);
    assert.equal(capturedBuyer, account);
    assert.equal(capturedAmount?.toString(), body.totalCreditMicroUsd);
    assert.equal(capturedId, "0x" + "1".repeat(64) + ":0");
  } finally {
    AntSeedFundingVaultClient.prototype.depositForBuyerWithId = original;
  }
});

test("outstanding endpoint returns failed funding credits", async () => {
  const original = AntSeedFundingVaultClient.prototype.depositForBuyerWithId;
  let capturedId: string | undefined;
  const now = Date.now;
  Date.now = () => 12345;
  AntSeedFundingVaultClient.prototype.depositForBuyerWithId = async function (_buyer: string, _amountMicroUsd: bigint, id: string) {
    capturedId = id;
    throw new Error("funding failed");
  };

  try {
    const account = "0x0000000000000000000000000000000000000abc";
    const testEnv = env();
    await worker.fetch(new Request("https://worker.test/v1/celo/deposits/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account, gdAmountWei: "1000000000000000000", source: "manual" })
    }), testEnv, {} as ExecutionContext);

    const outstandingRes = await worker.fetch(new Request(`https://worker.test/v1/accounts/${account}/outstanding`), testEnv, {} as ExecutionContext);
    assert.equal(outstandingRes.status, 200);
    const body = await outstandingRes.json() as { outstandingFundingMicroUsd: string; failedFundingCredits: Array<{ fundingStatus?: string; fundingId?: string }> };
    assert.equal(body.outstandingFundingMicroUsd, "1100000");
    assert.equal(body.failedFundingCredits.length, 1);
    assert.equal(body.failedFundingCredits[0].fundingStatus, "failed");
    assert.equal(body.failedFundingCredits[0].fundingId, "manual:12345");
    assert.equal(capturedId, "manual:12345");
  } finally {
    Date.now = now;
    AntSeedFundingVaultClient.prototype.depositForBuyerWithId = original;
  }
});

test("manual Celo credit without txHash/logIndex uses fallback deposit id", async () => {
  const original = AntSeedFundingVaultClient.prototype.depositForBuyerWithId;
  let capturedId: string | undefined;
  AntSeedFundingVaultClient.prototype.depositForBuyerWithId = async function (buyer: string, amountMicroUsd: bigint, id: string) {
    capturedId = id;
    return { enabled: false, buyer, amountMicroUsd: amountMicroUsd.toString() };
  };

  try {
    const account = "0x0000000000000000000000000000000000000abc";
    const res = await worker.fetch(new Request("https://worker.test/v1/celo/deposits/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account, gdAmountWei: "1000000000000000000", source: "manual" })
    }), env(), {} as ExecutionContext);
    assert.equal(res.status, 200);
    const body = await res.json() as { depositId: string };
    assert.ok(body.depositId.startsWith("manual:"));
    assert.equal(capturedId, body.depositId);
  } finally {
    AntSeedFundingVaultClient.prototype.depositForBuyerWithId = original;
  }
});
