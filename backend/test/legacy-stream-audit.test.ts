import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import {
  AuditDependencies,
  CloudflareKvReader,
  FundingEvidence,
  LegacyEntry,
  auditLegacyStreams,
  fetchFundingLogs,
  getAuditErrorMessage,
  resolveAuditConfig
} from "../scripts/audit-legacy-stream-credits.js";

test("audit errors expose validation failures without remote credentials or injected log lines", () => {
  assert.equal(getAuditErrorMessage(new Error("Expected --output <new-report.json>; use --help")), "Expected --output <new-report.json>; use --help");
  assert.equal(getAuditErrorMessage(new Error("KV list failed (403)")), "KV list failed (403)");
  const remote = Object.assign(new Error("https://user:password@example.com\nAuthorization: Bearer secret"), { code: "SERVER_ERROR" });
  assert.equal(getAuditErrorMessage(remote), "Operation failed (SERVER_ERROR)");
  assert.equal(getAuditErrorMessage({ code: "secret\nforged" }), "Operation failed (remote details omitted to protect credentials)");
});

test("audit config uses Wrangler deployment values and existing Base defaults", () => {
  const config = resolveAuditConfig(
    {
      account_id: "cf-account",
      vars: { ANTSEED_FUNDING_VAULT_ADDRESS: "operator" },
      kv_namespaces: [
        { binding: "OTHER", id: "wrong" },
        { binding: "ANTSEED_KV", id: "namespace" }
      ]
    },
    {}
  );
  assert.deepEqual(config, {
    accountId: "cf-account",
    namespaceId: "namespace",
    rpcUrl: "https://mainnet.base.org",
    operatorAddress: "operator",
    fromBlock: 48055111
  });
});

test("audit config prioritizes environment overrides and supports Wrangler RPC vars", () => {
  const wrangler = { vars: { ANTSEED_FUNDING_RPC_URL: "https://configured.example", FROM_BLOCK: "100" } };
  assert.equal(resolveAuditConfig(wrangler, {}).rpcUrl, "https://configured.example");
  assert.equal(resolveAuditConfig(wrangler, {}).fromBlock, 100);
  assert.deepEqual(
    resolveAuditConfig(wrangler, {
      CLOUDFLARE_ACCOUNT_ID: "override-account",
      ANTSEED_KV_NAMESPACE_ID: "override-kv",
      ANTSEED_FUNDING_RPC_URL: "https://override.example",
      ANTSEED_FUNDING_VAULT_ADDRESS: "override-operator",
      FROM_BLOCK: "200"
    }),
    {
      accountId: "override-account",
      namespaceId: "override-kv",
      rpcUrl: "https://override.example",
      operatorAddress: "override-operator",
      fromBlock: 200
    }
  );
  assert.throws(() => resolveAuditConfig({}, { FROM_BLOCK: "bad" }));
});

const account = "0x0000000000000000000000000000000000000001";
const root = "0x0000000000000000000000000000000000000002";

test("Etherscan paginates results over a fixed block range and decodes hex fields", async () => {
  const topic = id("BuyerDepositFundedWithId(address,uint256,uint256,string)");
  const log = (index: number) => ({
    blockNumber: "0x96",
    transactionHash: `0x${"a".repeat(64)}`,
    logIndex: `0x${index.toString(16)}`,
    data: "0x",
    topics: [topic]
  });
  const urls: URL[] = [];
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    assert.equal(url.origin, "https://api.etherscan.io");
    assert.equal(url.pathname, "/v2/api");
    assert.equal(url.searchParams.get("topic0"), topic);
    assert.equal(url.searchParams.get("chainid"), "8453");
    assert.equal(url.searchParams.get("module"), "logs");
    assert.equal(url.searchParams.get("action"), "getLogs");
    assert.equal(url.searchParams.get("apikey"), process.env.ETHERSCAN_API_KEY ?? "");
    assert.equal(url.searchParams.get("fromBlock"), "100");
    assert.equal(url.searchParams.get("toBlock"), "200");
    return Response.json({ status: "1", message: "OK", result: urls.length === 1 ? Array.from({ length: 1000 }, (_, index) => log(index)) : [log(1000)] });
  };
  const result = [];
  for await (const log of fetchFundingLogs(process.env.ETHERSCAN_API_KEY ?? "", account, 100, 200, request)) result.push(log);
  assert.equal(result.length, 1001);
  assert.equal(result[1000].index, 1000);
  assert.equal(result[0].blockNumber, 150);
  assert.deepEqual(result[0].topics, [topic]);
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get("page"), "2");
});

test("Etherscan fails closed on HTTP errors, API errors, malformed pages and duplicate results", async () => {
  const consume = async (request: typeof fetch) => {
    for await (const log of fetchFundingLogs(process.env.ETHERSCAN_API_KEY ?? "", account, 100, 200, request)) assert.ok(log);
  };
  await assert.rejects(
    consume(async () => new Response("unavailable", { status: 503 })),
    /Etherscan logs failed \(503\)/
  );
  await assert.rejects(consume(async () => Response.json({ items: [] })));
  await assert.rejects(
    consume(async () => Response.json({ status: "0", message: "NOTOK", result: "Invalid API key" })),
    /Etherscan API rejected/
  );
  const log = {
    blockNumber: "0x96",
    transactionHash: `0x${"a".repeat(64)}`,
    logIndex: "0x0",
    data: "0x",
    topics: [id("BuyerDepositFundedWithId(address,uint256,uint256,string)")]
  };
  await assert.rejects(
    consume(async () => Response.json({ status: "1", message: "OK", result: [log, log] })),
    /duplicate logs/
  );
  await assert.rejects(
    consume(async () => Response.json({ status: "1", message: "OK", result: [{ ...log, blockNumber: "0x1" }] })),
    /outside the requested filter/
  );
  await consume(async () => Response.json({ status: "0", message: "No records found", result: [] }));
});

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
const proof = (changes: Partial<FundingEvidence> = {}): FundingEvidence => ({
  buyer: account,
  principalUsd: "10",
  bonusUsd: "2",
  txHash: "0x123",
  blockNumber: 100,
  fundedAt: "2026-09-01T01:00:00.000Z",
  ...changes
});

function dependencies(entries: LegacyEntry[], used = false, evidence?: FundingEvidence, clock?: string): AuditDependencies {
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
    async evidence() {
      return evidence;
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
    ["kv.audit.progress", "kv.audit.legacy-entry", "kv.audit.complete"]
  );
  assert.deepEqual(events.at(-1)?.details, report.counts);
  assert.ok(!JSON.stringify(events).includes(account));
  assert.ok(!JSON.stringify(events).includes("stream:2026-09-01"));
});

test("audit flags a landed deposit with a stale KV status without writing or inventing a cutoff", async () => {
  const old = entry();
  const before = JSON.stringify(old);
  const report = await auditLegacyStreams(dependencies([old], true, proof()));
  const finding = report.findings[0];
  assert.ok(finding.issues.includes("landed_deposit_not_recorded_as_funded"));
  assert.equal(finding.evidence?.fundedAt, "2026-09-01T01:00:00.000Z");
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

test("audit checks event amounts, buyer and legacy root clock mirroring", async () => {
  const report = await auditLegacyStreams(dependencies([entry({ rootAccount: root })], true, proof({ buyer: root, bonusUsd: "0" })));
  assert.ok(report.findings[0].issues.includes("legacy_root_clock_may_be_mirrored"));
  assert.ok(report.findings[0].issues.includes("funding_amount_mismatch"));
  assert.ok(report.findings[0].issues.includes("funding_buyer_mismatch"));
});

test("audit refuses to treat a used ID without event evidence as a clean record", async () => {
  const report = await auditLegacyStreams(dependencies([entry({ fundingStatus: "funded" })], true, undefined, "2026-09-01T00:00:00Z"));
  assert.ok(report.findings[0].issues.includes("used_id_without_funding_event_in_scan_range"));
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

test("KV reader paginates every credit key using GET requests only", async () => {
  const urls: URL[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    urls.push(url);
    assert.equal(init?.method ?? "GET", "GET");
    if (url.pathname.includes("/values/")) return Response.json({ id: "second" });
    assert.equal(url.searchParams.get("prefix"), "gd-credit:");
    return Response.json(
      url.searchParams.has("cursor")
        ? { success: true, result: [{ name: "gd-credit:second" }], result_info: { cursor: "" } }
        : { success: true, result: [{ name: "gd-credit:first" }], result_info: { cursor: "next" } }
    );
  };
  const kv = new CloudflareKvReader("account", "namespace", "token", request);
  const keys: string[] = [];
  for await (const key of kv.keys()) keys.push(key);
  assert.deepEqual(keys, ["gd-credit:first", "gd-credit:second"]);
  assert.equal(urls[1].searchParams.get("cursor"), "next");
  assert.deepEqual(await kv.get("gd-credit:second"), { id: "second" });
});

test("KV reader fails closed on API errors and repeated cursors", async () => {
  const failed = new CloudflareKvReader("account", "namespace", "token", async () => new Response("secret", { status: 403 }));
  await assert.rejects(async () => {
    for await (const _key of failed.keys()) {
      /* Exhaust the iterator. */
    }
  }, /KV list failed \(403\)/);
  const repeating = new CloudflareKvReader("account", "namespace", "token", async () =>
    Response.json({ success: true, result: [], result_info: { cursor: "same" } })
  );
  await assert.rejects(async () => {
    for await (const _key of repeating.keys()) {
      /* Exhaust the iterator. */
    }
  }, /repeated a cursor/);
});
