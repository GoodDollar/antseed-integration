import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import {
  AuditDependencies,
  WorkerApiReader,
  LegacyEntry,
  StreamedReconciliation,
  auditLegacyStreams,
  getAuditErrorMessage,
  resolveAuditConfig
} from "../scripts/audit-legacy-stream-credits.js";

test("audit errors expose validation failures without remote credentials or injected log lines", () => {
  assert.equal(getAuditErrorMessage(new Error("Expected --output <new-report.json>; use --help")), "Expected --output <new-report.json>; use --help");
  assert.equal(getAuditErrorMessage(new Error("API read failed (403)")), "API read failed (403)");
  const remote = Object.assign(new Error("https://user:password@example.com\nAuthorization: Bearer secret"), { code: "SERVER_ERROR" });
  assert.equal(getAuditErrorMessage(remote), "Operation failed (SERVER_ERROR)");
  assert.equal(getAuditErrorMessage({ code: "secret\nforged" }), "Operation failed (remote details omitted to protect credentials)");
});

test("audit config uses Wrangler deployment values and existing Base defaults", () => {
  const config = resolveAuditConfig({ vars: { ANTSEED_FUNDING_VAULT_ADDRESS: "operator" } }, {});
  assert.deepEqual(config, {
    apiBaseUrl: undefined,
    rpcUrl: "https://mainnet.base.org",
    operatorAddress: "operator",
    celoVaultAddress: undefined,
    gdSuperTokenAddress: undefined,
    subgraphUrl: undefined
  });
});

test("audit config prioritizes environment overrides and supports Wrangler RPC vars", () => {
  const wrangler = { vars: { ANTSEED_FUNDING_RPC_URL: "https://configured.example", CELO_VAULT_ADDRESS: "celo-vault" } };
  assert.equal(resolveAuditConfig(wrangler, {}).rpcUrl, "https://configured.example");
  assert.deepEqual(
    resolveAuditConfig(wrangler, {
      ANTSEED_API_URL: "https://worker.example",
      ANTSEED_FUNDING_RPC_URL: "https://override.example",
      ANTSEED_FUNDING_VAULT_ADDRESS: "override-operator",
      CELO_VAULT_ADDRESS: "override-celo-vault",
      CELO_GD_SUPERTOKEN_ADDRESS: "override-supertoken",
      SUPERFLUID_SUBGRAPH_URL: "https://override-subgraph.example"
    }),
    {
      apiBaseUrl: "https://worker.example",
      rpcUrl: "https://override.example",
      operatorAddress: "override-operator",
      celoVaultAddress: "override-celo-vault",
      gdSuperTokenAddress: "override-supertoken",
      subgraphUrl: "https://override-subgraph.example"
    }
  );
});

const account = "0x0000000000000000000000000000000000000001";
const root = "0x0000000000000000000000000000000000000002";

const entry = (changes: Partial<LegacyEntry> = {}): LegacyEntry => ({
  id: "stream:2026-09-01:account",
  account,
  rootAccount: account,
  source: "streamCron",
  fundingStatus: "pending",
  gdAmountWei: "100",
  principalUsd: "10",
  bonusUsd: "2",
  totalCreditUsd: "12",
  createdAt: "2026-09-01T00:00:00.000Z",
  ...changes
});

function dependencies(entries: LegacyEntry[], used = false, reconciliations?: StreamedReconciliation[], clock?: string): AuditDependencies {
  return {
    async *keys() {
      for (const item of entries) yield `gd-credit:${item.id}`;
    },
    async get(key) {
      if (key.startsWith("user:")) return { lastStreamCreditAt: clock };
      return entries.find((item) => key === `gd-credit:${item.id}`);
    },
    async used() {
      return used;
    },
    async reconcile() {
      return new Map((reconciliations ?? []).map((row) => [row.account, row]));
    }
  };
}

test("audit emits progress and completion counts without wallet or raw record data", async () => {
  const deps = dependencies([entry()]);
  const events: Array<{ event: string; details: Record<string, unknown> }> = [];
  deps.progress = (event, details) => events.push({ event, details });
  const report = await auditLegacyStreams(deps);
  assert.deepEqual(
    events.map((item) => item.event),
    ["kv.audit.progress", "kv.audit.legacy-entry", "kv.audit.reconciling", "kv.audit.complete"]
  );
  assert.deepEqual(events.at(-1)?.details, report.counts);
  assert.ok(!JSON.stringify(events).includes(account));
  assert.ok(!JSON.stringify(events).includes("stream:2026-09-01"));
});

test("audit flags a landed deposit with a stale KV status without writing or inventing a cutoff", async () => {
  const old = entry();
  const before = JSON.stringify(old);
  const report = await auditLegacyStreams(dependencies([old], true));
  const finding = report.findings[0];
  assert.ok(finding.issues.includes("landed_deposit_not_recorded_as_funded"));
  assert.equal(finding.lastStreamCreditAt, undefined);
  assert.equal(JSON.stringify(old), before);
  assert.equal(report.readOnly, true);
});

test("audit flags unfunded legacy records for replay and accounting reconciliation", async () => {
  const report = await auditLegacyStreams(dependencies([entry({ fundingStatus: "failed" })]));
  assert.ok(report.findings[0].issues.includes("unfunded_legacy_entry"));
  assert.match(report.findings[0].action, /prevent later replay/);
});

test("audit excludes regular deposits and new stream-window entries from on-chain checks", async () => {
  const deps = dependencies([entry({ id: "deposit", source: "deposit" }), entry({ id: "new-stream", streamCreditedThrough: "2026-09-01T00:00:00.000Z" })]);
  deps.used = async () => {
    throw new Error("Must not inspect excluded IDs");
  };
  const report = await auditLegacyStreams(deps);
  assert.equal(report.counts.skippedDeposits, 1);
  assert.equal(report.counts.skippedNewStreams, 1);
  assert.equal(report.counts.needsReview, 0);
});

test("audit reports funded KV records whose IDs are unused", async () => {
  const report = await auditLegacyStreams(dependencies([entry({ fundingStatus: "funded" })], false, undefined, "2026-09-01T00:00:00Z"));
  assert.ok(report.findings[0].issues.includes("funded_in_kv_but_id_unused_on_chain"));
});

test("audit flags legacy root clock mirroring", async () => {
  const report = await auditLegacyStreams(dependencies([entry({ rootAccount: root })], true));
  assert.ok(report.findings[0].issues.includes("legacy_root_clock_may_be_mirrored"));
});

test("audit retains existing clocks and flags zero-amount acknowledgements", async () => {
  const old = entry({ fundingStatus: "funded", source: "streamUpdate", principalUsd: "0", bonusUsd: "0", totalCreditUsd: "0" });
  const report = await auditLegacyStreams(dependencies([old], false, undefined, "2026-09-01T00:00:00Z"));
  assert.equal(report.findings[0].lastStreamCreditAt, "2026-09-01T00:00:00Z");
  assert.ok(report.findings[0].issues.includes("legacy_zero_amount_ack_may_have_advanced_clock"));
  assert.ok(!report.findings[0].issues.includes("funded_in_kv_but_id_unused_on_chain"));
});

test("audit reports malformed and missing records without silently dropping them", async () => {
  const deps = dependencies([entry()]);
  deps.get = async () => undefined;
  const report = await auditLegacyStreams(deps);
  assert.equal(report.counts.needsReview, 1);
  assert.deepEqual(report.findings[0].issues, ["invalid_or_missing_credit_record"]);
});

test("API reader pages through credit history and stops when the Worker says there is no more", async () => {
  const paths: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(`${url.pathname}?${url.searchParams}`);
    assert.equal(init?.method ?? "GET", "GET");
    if (url.pathname.endsWith("/profile")) return Response.json({ profile: { totalGDStreamedWei: "7" } });
    const offset = Number(url.searchParams.get("offset"));
    return Response.json({ items: [{ id: `entry-${offset}` }], hasMore: offset === 0 });
  };
  const api = new WorkerApiReader("https://worker.example", request);
  assert.deepEqual(await api.profile(account), { totalGDStreamedWei: "7" });
  const ids: string[] = [];
  for await (const item of api.creditHistory(account)) ids.push((item as { id: string }).id);
  assert.deepEqual(ids, ["entry-0", "entry-100"]);
  assert.equal(paths[1], `/v1/accounts/${account}/credit-history?limit=100&offset=0`);
  assert.equal(paths[2], `/v1/accounts/${account}/credit-history?limit=100&offset=100`);
});

test("API reader treats a missing profile as absent and any other failure as fatal", async () => {
  assert.equal(await new WorkerApiReader("https://worker.example", async () => new Response(null, { status: 404 })).profile(account), undefined);
  const failing = new WorkerApiReader("https://worker.example", async () => new Response("secret", { status: 403 }));
  await assert.rejects(() => failing.profile(account), /API read failed \(403\)/);
});

// The reconciliation is the check that catches accounting drift directly: a profile claiming far
// more streamed than Superfluid ever carried fails here even when every individual entry looks
// healthy on its own. This is the shape the production account showed -- 6.2M G$ credited against
// ~7.1k G$ actually streamed.
test("audit flags a profile credited more than the stream ever carried", async () => {
  const report = await auditLegacyStreams(
    dependencies([], false, [
      { account, owedToClockWei: 7_134n, creditedWei: 6_211_113n, maxFlowRateWeiPerSecond: 2n, lastStreamCreditAt: "2026-09-11T06:00:27.949Z" }
    ])
  );
  const finding = report.findings.find((item) => item.key === `user:${account}`);
  assert.ok(finding?.issues.includes("credited_more_than_streamed"));
  assert.equal(report.counts.reconciliationMismatches, 1);
  assert.ok(finding?.action.includes("6211113"));
  // Drift priced in seconds of the account's own flow: (6211113 - 7134) / 2.
  assert.ok(finding?.action.includes("3101989s of flow"), finding?.action);
});

// A few seconds of flow is the credit path truncating to whole seconds, not lost money; months of it
// is a real defect. Reporting both as a raw wei count makes them look alike, so the magnitude is
// expressed in the account's own terms -- and still reported, never suppressed by a guessed epsilon.
test("audit prices drift in seconds of flow when the account's rate is known", async () => {
  const report = await auditLegacyStreams(
    dependencies([], false, [{ account, owedToClockWei: 1_000n, creditedWei: 954n, maxFlowRateWeiPerSecond: 23n }])
  );
  assert.ok(report.findings[0].action.includes("short by 46 = 2s of flow"), report.findings[0].action);
});

test("audit omits the seconds-of-flow hint when no rate is known", async () => {
  const report = await auditLegacyStreams(dependencies([], false, [{ account, owedToClockWei: 1_000n, creditedWei: 954n }]));
  assert.ok(!report.findings[0].action.includes("of flow"), report.findings[0].action);
});

test("audit flags a profile credited less than the stream carried", async () => {
  const report = await auditLegacyStreams(
    dependencies([], false, [{ account, owedToClockWei: 5_000n, creditedWei: 1_000n }])
  );
  assert.ok(report.findings[0].issues.includes("credited_less_than_streamed"));
  assert.ok(report.findings[0].action.includes("clock may have advanced past unpaid time"));
});

test("audit reports no reconciliation finding when KV matches the subgraph", async () => {
  const report = await auditLegacyStreams(dependencies([], false, [{ account, owedToClockWei: 5_000n, creditedWei: 5_000n }]));
  assert.equal(report.counts.reconciliationMismatches, 0);
  assert.deepEqual(report.findings, []);
});
