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

const GD_PRICE = 1.0; // 1 G$ = $1.00 cUSD

test("recordGdCredit persists entry and updates user profile", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  const entry = await store.recordGdCredit({
    id: "deposit:1",
    account: "0xABC",
    rootAccount: "0xROOT",
    source: "deposit",
    gdAmountWei: 10_000_000_000_000_000_000n, // 10 G$
    gdPrice: GD_PRICE,
    isVerified: true,
    maxBonusCapMicroUsd: 100_000_000n
  });

  assert.equal(entry.account, "0xabc");
  assert.equal(entry.source, "deposit");
  assert.equal(entry.principalMicroUsd, "10000000");
  assert.equal(entry.bonusMicroUsd, "1000000"); // 10% bonus for deposit
  assert.equal(entry.totalCreditMicroUsd, "11000000");
  assert.equal(entry.fundingStatus, "pending");

  const user = await store.getUser("0xABC");
  assert.equal(user.totalGdDepositedWei, "10000000000000000000");
  assert.equal(user.totalOutstandingFundingMicroUsd, "11000000");
});

test("recordGdCredit is idempotent on duplicate id", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  const first = await store.recordGdCredit({
    id: "deposit:dup",
    account: "0xABC",
    rootAccount: "0xROOT",
    source: "deposit",
    gdAmountWei: 1_000_000_000_000_000_000n,
    gdPrice: GD_PRICE,
    isVerified: true,
    maxBonusCapMicroUsd: 100_000_000n
  });
  const second = await store.recordGdCredit({
    id: "deposit:dup",
    account: "0xABC",
    rootAccount: "0xROOT",
    source: "deposit",
    gdAmountWei: 1_000_000_000_000_000_000n,
    gdPrice: GD_PRICE,
    isVerified: true,
    maxBonusCapMicroUsd: 100_000_000n
  });

  assert.deepEqual(first, second);

  const credits = await store.getGdCredits("0xABC");
  assert.equal(credits.length, 1);
});

test("recordGdCredit gives streaming bonus (20%) for stream sources", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  const entry = await store.recordGdCredit({
    id: "stream:2026-05-28:0xabc",
    account: "0xABC",
    source: "streamRequest",
    gdAmountWei: 1_000_000_000_000_000_000n, // 1 G$
    flowRate: 385_802_469_136n,
    rootAccount: "0xROOT",
    gdPrice: GD_PRICE,
    isVerified: true,
    maxBonusCapMicroUsd: 100_000_000n
  });

  assert.equal(entry.principalMicroUsd, "1000000");
  assert.equal(entry.bonusMicroUsd, "200000"); // 20% streaming bonus
  assert.equal(entry.totalCreditMicroUsd, "1200000");

  const user = await store.getUser("0xABC");
  assert.equal(user.totalGDStreamedWei, "1000000000000000000");
  assert.equal(user.streamFlowRateWeiPerSecond, "385802469136");
});

test("recordGdCredit gives no bonus for unverified accounts", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  const entry = await store.recordGdCredit({
    id: "deposit:unverified",
    account: "0xABC",
    source: "deposit",
    gdAmountWei: 1_000_000_000_000_000_000n,
    gdPrice: GD_PRICE,
    isVerified: false,
    maxBonusCapMicroUsd: 100_000_000n
  });

  assert.equal(entry.principalMicroUsd, "1000000");
  assert.equal(entry.bonusMicroUsd, "0");
  assert.equal(entry.totalCreditMicroUsd, "1000000");
});

test("recordGdCredit enforces monthly bonus cap per root account", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  const cap = 500_000n; // $0.50 cap

  // First deposit: gets full bonus ($0.10 on $1)
  const first = await store.recordGdCredit({
    id: "deposit:cap1",
    account: "0xAAA",
    rootAccount: "0xROOT",
    source: "deposit",
    gdAmountWei: 1_000_000_000_000_000_000n,
    gdPrice: GD_PRICE,
    isVerified: true,
    maxBonusCapMicroUsd: cap
  });
  assert.equal(first.bonusMicroUsd, "100000"); // full 10%

  // Second deposit from different wallet same root: bonus clamped
  const second = await store.recordGdCredit({
    id: "deposit:cap2",
    account: "0xBBB",
    rootAccount: "0xROOT",
    source: "deposit",
    gdAmountWei: 10_000_000_000_000_000_000n, // 10 G$ → would be $1 bonus
    gdPrice: GD_PRICE,
    isVerified: true,
    maxBonusCapMicroUsd: cap
  });
  assert.equal(second.bonusMicroUsd, "400000"); // capped to remaining $0.40

  // Third deposit: no bonus left
  const third = await store.recordGdCredit({
    id: "deposit:cap3",
    account: "0xCCC",
    rootAccount: "0xROOT",
    source: "deposit",
    gdAmountWei: 1_000_000_000_000_000_000n,
    gdPrice: GD_PRICE,
    isVerified: true,
    maxBonusCapMicroUsd: cap
  });
  assert.equal(third.bonusMicroUsd, "0");
});

test("markFundingResult updates entry status and user profile on success", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  const entry = await store.recordGdCredit({
    id: "deposit:fund1",
    account: "0xABC",
    rootAccount: "0xROOT",
    source: "deposit",
    gdAmountWei: 1_000_000_000_000_000_000n,
    gdPrice: GD_PRICE,
    isVerified: true,
    maxBonusCapMicroUsd: 100_000_000n
  });

  assert.equal(entry.fundingStatus, "pending");

  const funded = await store.markFundingResult(entry, { funded: true, txHash: "0xfund123" });
  assert.equal(funded.fundingStatus, "funded");
  assert.equal(funded.fundingTxHash, "0xfund123");

  const user = await store.getUser("0xABC");
  assert.equal(user.totalPrincipalMicroUsd, "1000000");
  assert.equal(user.totalBonusMicroUsd, "100000");
  assert.equal(user.totalOutstandingFundingMicroUsd, "0");
});

test("markFundingResult records failure without updating user totals", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  const entry = await store.recordGdCredit({
    id: "deposit:fail1",
    account: "0xABC",
    rootAccount: "0xROOT",
    source: "deposit",
    gdAmountWei: 1_000_000_000_000_000_000n,
    gdPrice: GD_PRICE,
    isVerified: true,
    maxBonusCapMicroUsd: 100_000_000n
  });

  const failed = await store.markFundingResult(entry, { funded: false, error: "tx reverted" });
  assert.equal(failed.fundingStatus, "failed");
  assert.equal(failed.fundingError, "tx reverted");

  const user = await store.getUser("0xABC");
  assert.equal(user.totalPrincipalMicroUsd, "0"); // not updated on failure
  assert.equal(user.totalOutstandingFundingMicroUsd, "1100000"); // still outstanding
});

test("markFundingResult is idempotent for already-funded entries", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  const entry = await store.recordGdCredit({
    id: "deposit:idem",
    account: "0xABC",
    rootAccount: "0xROOT",
    source: "deposit",
    gdAmountWei: 1_000_000_000_000_000_000n,
    gdPrice: GD_PRICE,
    isVerified: true,
    maxBonusCapMicroUsd: 100_000_000n
  });

  const funded = await store.markFundingResult(entry, { funded: true, txHash: "0xfirst" });
  const again = await store.markFundingResult(funded, { funded: true, txHash: "0xsecond" });
  assert.equal(again.fundingTxHash, "0xfirst"); // unchanged
});

test("recordGdCredit tracks credits under both wallet and root account", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  await store.recordGdCredit({
    id: "deposit:root1",
    account: "0xWALLET",
    rootAccount: "0xROOT",
    source: "deposit",
    gdAmountWei: 1_000_000_000_000_000_000n,
    gdPrice: GD_PRICE,
    isVerified: true,
    maxBonusCapMicroUsd: 100_000_000n
  });

  const walletCredits = await store.getGdCredits("0xWALLET");
  const rootCredits = await store.getGdCredits("0xROOT");
  assert.equal(walletCredits.length, 1);
  assert.equal(rootCredits.length, 1);
  assert.equal(walletCredits[0].account, "0xwallet");
  assert.equal(walletCredits[0].rootAccount, "0xroot");

  const walletProfile = await store.getUser("0xWALLET");
  const rootProfile = await store.getUser("0xROOT");
  assert.equal(walletProfile.rootAccount, "0xroot");
  assert.equal(rootProfile.rootAccount, "0xroot");
  assert.equal(walletProfile.totalGdDepositedWei, "1000000000000000000");
  assert.equal(rootProfile.totalGdDepositedWei, "1000000000000000000");
});

test("getUser returns default profile for unknown account", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  const user = await store.getUser("0xNOBODY");
  assert.equal(user.account, "0xnobody");
  assert.equal(user.totalGdDepositedWei, "0");
  assert.equal(user.totalPrincipalMicroUsd, "0");
  assert.equal(user.totalBonusMicroUsd, "0");
  assert.equal(user.totalOutstandingFundingMicroUsd, "0");
  assert.equal(user.streamFlowRateWeiPerSecond, "0");
});

test("markFundingResult updates lastStreamCreditAt for stream sources", async () => {
  const store = new KVCreditStore(new MemoryKV() as never);
  const entry = await store.recordGdCredit({
    id: "stream:2026-05-28:0xabc",
    account: "0xABC",
    source: "streamCron",
    gdAmountWei: 1_000_000_000_000_000_000n,
    flowRate: 385_802_469_136n,
    rootAccount: "0xROOT",
    gdPrice: GD_PRICE,
    isVerified: true,
    maxBonusCapMicroUsd: 100_000_000n
  });

  assert.equal(entry.fundingStatus, "pending");
  const before = (await store.getUser("0xABC")).createdAt;
  await store.markFundingResult(entry, { funded: true, txHash: "0xstream" });
  const after = await store.getUser("0xABC");

  // lastStreamCreditAt should be updated for stream sources
  assert.notEqual(after.lastStreamCreditAt, before);
});
