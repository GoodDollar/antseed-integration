import assert from "node:assert/strict";
import test from "node:test";
import { Entry, Profile, rebuildCounters, repairProfile, workerApi } from "../scripts/repair-stream-counters.js";

const entry = (changes: Partial<Entry> = {}): Entry => ({
  id: "stream:2026-09-01:account",
  source: "streamCron",
  fundingStatus: "funded",
  gdAmountWei: "1000",
  totalCreditUsd: "10",
  ...changes
});

const profile = (changes: Partial<Profile> = {}): Profile => ({
  account: "0xabc",
  totalGDStreamedWei: "0",
  totalGdDepositedWei: "0",
  totalOutstandingFundingUsd: "0",
  totalPrincipalUsd: "0",
  totalBonusUsd: "0",
  ...changes
});

// The whole point of the repair: a failed entry contributed to the totals before the `credited` guard
// existed, which is how one 6,191,029 G$ failed window produced a 6.2M G$ profile. Rebuilding must
// count only what funded.
test("rebuildCounters ignores entries that did not fund", () => {
  const counters = rebuildCounters([
    entry({ id: "paid", gdAmountWei: "500" }),
    entry({ id: "failed", fundingStatus: "failed", gdAmountWei: "6191029" }),
    entry({ id: "pending", fundingStatus: "pending", gdAmountWei: "7000", totalCreditUsd: "730" })
  ]);
  assert.equal(counters.totalGDStreamedWei, "500", "only the funded stream entry counts");
  assert.equal(counters.totalGdDepositedWei, "500");
  assert.equal(counters.totalOutstandingFundingUsd, "730", "a pending entry is owed but unpaid");
});

test("rebuildCounters separates stream credit from one-time deposits", () => {
  const counters = rebuildCounters([entry({ id: "s", gdAmountWei: "300" }), entry({ id: "d", source: "deposit", gdAmountWei: "700" })]);
  assert.equal(counters.totalGDStreamedWei, "300", "deposits are not streamed G$");
  assert.equal(counters.totalGdDepositedWei, "1000", "but both count toward the lifetime total");
});

test("rebuildCounters counts every stream source", () => {
  const sources = ["streamCron", "streamUpdate", "streamRequest"];
  const counters = rebuildCounters(sources.map((source, index) => entry({ id: `s${index}`, source, gdAmountWei: "100" })));
  assert.equal(counters.totalGDStreamedWei, "300");
});

// Sums exceed 2^53 in practice -- the account that prompted this held 6.2e24 wei -- so the arithmetic
// has to stay in BigInt all the way to the string.
test("rebuildCounters stays exact past Number precision", () => {
  const huge = "6211113374652777379377929";
  assert.equal(rebuildCounters([entry({ gdAmountWei: huge })]).totalGDStreamedWei, huge);
});

// The clock is the one field that must never move: the cron credits forward from it, so winding it
// back would re-credit history that was already paid.
test("repairProfile preserves the stream clock and the granted-credit totals", () => {
  const before = profile({
    totalGDStreamedWei: "6211113374652777379377929",
    totalGdDepositedWei: "6229114374652777379377929",
    totalOutstandingFundingUsd: "730541511",
    totalPrincipalUsd: "4254046",
    totalBonusUsd: "99",
    lastStreamCreditAt: "2026-09-11T06:00:27.949Z"
  });
  const repaired = repairProfile(before, [entry({ gdAmountWei: "19283455" })], "2026-10-14T00:00:00.000Z");
  assert.equal(repaired?.lastStreamCreditAt, "2026-09-11T06:00:27.949Z");
  assert.equal(repaired?.totalPrincipalUsd, "4254046", "granted credit is mirrored on Base; KV must not disagree");
  assert.equal(repaired?.totalBonusUsd, "99");
  assert.equal(repaired?.totalGDStreamedWei, "19283455");
  assert.equal(repaired?.totalOutstandingFundingUsd, "0", "the failed window stops being outstanding");
  assert.equal(repaired?.updatedAt, "2026-10-14T00:00:00.000Z");
});

test("repairProfile keeps fields it does not know about", () => {
  const before = profile({ streamFlowRateWeiPerSecond: "3433641975308641", createdAt: "2026-07-02T18:22:52.077Z" }) as Profile & Record<string, unknown>;
  const repaired = repairProfile(before, [entry()], "2026-10-14T00:00:00.000Z") as (Profile & Record<string, unknown>) | undefined;
  assert.equal(repaired?.streamFlowRateWeiPerSecond, "3433641975308641");
  assert.equal(repaired?.createdAt, "2026-07-02T18:22:52.077Z");
});

// A healthy account must produce no write at all, so a repair run cannot churn profiles it does not
// need to touch -- every write races the scheduled run.
test("repairProfile returns nothing when the counters already agree", () => {
  const consistent = profile({ totalGDStreamedWei: "1000", totalGdDepositedWei: "1000" });
  assert.equal(repairProfile(consistent, [entry()], "2026-10-14T00:00:00.000Z"), undefined);
});

test("workerApi pages the credit history and stops when the Worker says there is no more", async () => {
  const paths: string[] = [];
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(`${url.pathname}?${url.searchParams}`);
    if (url.pathname.endsWith("/profile")) return Response.json({ profile: profile({ account: "0xabc" }) });
    const offset = Number(url.searchParams.get("offset"));
    return Response.json({ items: [entry({ id: `e-${offset}` })], hasMore: offset === 0 });
  };
  const api = workerApi("https://worker.test", request);
  assert.equal((await api.profile("0xabc")).account, "0xabc");
  assert.deepEqual((await api.entries("0xabc")).map((item) => item.id), ["e-0", "e-100"]);
  assert.equal(paths[2], "/v1/accounts/0xabc/credit-history?limit=100&offset=100");
});

test("workerApi fails closed rather than repairing from a partial read", async () => {
  const failing = workerApi("https://worker.test", async () => new Response("nope", { status: 500 }));
  await assert.rejects(() => failing.profile("0xabc"), /API read failed \(500\)/);
});
