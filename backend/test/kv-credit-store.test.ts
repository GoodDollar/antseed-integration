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

  const requests = await store.getUserRequests("0xABC");
  assert.equal(requests.length, 1);
});
