import test from "node:test";
import assert from "node:assert/strict";
import { KVCreditStore } from "../src/kv-credit-store.js";

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

test("KV store persists user profile and request lifecycle", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  await store.recordGdCredit({
    account: "0xABC",
    source: "manual",
    gdAmountWei: 10_000_000_000_000_000n,
    principalMicroUsd: 10_000n
  });
  const reservation = await store.reserve("0xABC", 2500n);

  assert.equal(reservation.account, "0xabc");
  assert.equal(reservation.status, "reserved");

  await store.markVaultReserved(reservation.requestId, "0xreserve");
  await store.settle(reservation.requestId, 1500n, "0xreceipt", "0xsettle");

  const saved = await store.getReservation(reservation.requestId);
  assert.equal(saved?.status, "settled");
  assert.equal(saved?.actualCostMicroUsd, "1500");
  assert.equal(saved?.vaultReserveTxHash, "0xreserve");
  assert.equal(saved?.vaultSettleTxHash, "0xsettle");

  const user = await store.getUser("0xABC");
  assert.equal(user.totalRequests, 1);
  assert.equal(user.totalReservedMicroUsd, "2500");
  assert.equal(user.totalSettledMicroUsd, "1500");
  assert.equal(user.reservedCreditMicroUsd, "0");
  assert.equal(user.creditBalanceMicroUsd, "9500");

  const requests = await store.getUserRequests("0xABC");
  assert.equal(requests.length, 1);
});

test("KV store rejects AntSeed reservations without enough G$ credit", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  await assert.rejects(() => store.reserve("0xABC", 1n), /insufficient credit balance/);
});

test("KV store releases reserved credit back to available balance", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  await store.recordGdCredit({ account: "0xABC", source: "manual", gdAmountWei: 10n, principalMicroUsd: 1000n });
  const reservation = await store.reserve("0xABC", 500n);
  await store.release(reservation.requestId, "0xrelease");
  const user = await store.getUser("0xABC");
  assert.equal(user.creditBalanceMicroUsd, "1100");
  assert.equal(user.reservedCreditMicroUsd, "0");
});

test("KV store keeps additional GoodID-root aggregate across connected wallets", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  await store.updateStream("0xAAA", "0xROOT", 385802469136n, 1_000_000n);
  const entry = await store.recordGdCredit({
    account: "0xBBB",
    rootAccount: "0xROOT",
    source: "erc677",
    gdAmountWei: 1_000_000_000_000_000_000n,
    principalMicroUsd: 1_000_000n
  });

  assert.equal(entry.rootAccount, "0xroot");
  assert.equal(entry.totalCreditMicroUsd, "1200000");

  const walletProfile = await store.getUser("0xBBB");
  const rootProfile = await store.getUser("0xROOT");
  assert.equal(walletProfile.rootAccount, "0xroot");
  assert.equal(walletProfile.creditBalanceMicroUsd, "1200000");
  assert.equal(rootProfile.creditBalanceMicroUsd, "1200000");

  const rootCredits = await store.getGdCredits("0xROOT");
  assert.equal(rootCredits.length, 1);
  assert.equal(rootCredits[0].account, "0xbbb");
});

test("KV store persists stream cap and G$ credit bonuses", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  await store.updateStream("0xABC", undefined, 385802469136n, 1_000_000n, undefined, "0xstream", 1);

  const first = await store.recordGdCredit({
    account: "0xABC",
    source: "erc677",
    gdAmountWei: 1_000_000_000_000_000_000n,
    principalMicroUsd: 1_000_000n,
    txHash: "0xdeposit1",
    logIndex: 2
  });
  assert.equal(first.totalCreditMicroUsd, "1200000");
  assert.equal(first.streamingBonusMicroUsd, "100000");

  const second = await store.recordGdCredit({
    account: "0xABC",
    source: "erc777",
    gdAmountWei: 1_000_000_000_000_000_000n,
    principalMicroUsd: 1_000_000n,
    txHash: "0xdeposit2",
    logIndex: 3
  });
  assert.equal(second.totalCreditMicroUsd, "1100000");
  assert.equal(second.streamingBonusMicroUsd, "0");

  const user = await store.getUser("0xABC");
  assert.equal(user.creditBalanceMicroUsd, "2300000");
  assert.equal(user.totalGdCreditsIssuedMicroUsd, "2300000");
  assert.equal(user.totalStreamingBonusMicroUsd, "100000");

  const credits = await store.getGdCredits("0xABC");
  assert.equal(credits.length, 2);
});
