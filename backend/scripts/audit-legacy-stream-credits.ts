import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Contract, Interface, JsonRpcProvider, getAddress, id } from "ethers";
import { base } from "viem/chains";
import { z } from "zod";
import { RuntimeConfig } from "../src/env.js";
import { fetchStreamPeriods, streamOwedWei } from "../src/stream-periods.js";

const CREDIT_PREFIX = "gd-credit:";
const STREAM_SOURCES = new Set(["streamUpdate", "streamRequest", "streamCron"]);
const unsigned = z.string().regex(/^\d+$/);
const address = z.string().refine((value) => {
  try {
    getAddress(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid address");
const entrySchema = z
  .object({
    id: z.string().min(1),
    account: address,
    rootAccount: address,
    buyerAddress: address.optional(),
    source: z.string(),
    fundingStatus: z.enum(["pending", "failed", "funded"]),
    principalUsd: unsigned,
    bonusUsd: unsigned,
    totalCreditUsd: unsigned,
    gdAmountWei: unsigned,
    createdAt: z.string().datetime(),
    streamCreditedThrough: z.string().optional()
  })
  .passthrough();

export type LegacyEntry = z.infer<typeof entrySchema>;
/** What Superfluid says an account actually streamed, and what KV claims it was credited. */
export type StreamedReconciliation = {
  account: string;
  /** Sum of the account's periods up to its stream clock -- what the backend should have credited. */
  owedToClockWei: bigint;
  /** `totalGDStreamedWei` on the profile. */
  creditedWei: bigint;
  /** Highest rate the account ever ran, used to express drift as seconds of flow. */
  maxFlowRateWeiPerSecond?: bigint;
  lastStreamCreditAt?: string;
};
export type AuditDependencies = {
  keys(): AsyncIterable<string>;
  get(key: string): Promise<unknown>;
  /** `usedDepositIds(keccak256(id))` on the operator: did this entry's deposit actually land. */
  used(entryId: string): Promise<boolean>;
  /** Per-account reconciliation of streamed-vs-credited, keyed by lowercase account. */
  reconcile(): Promise<Map<string, StreamedReconciliation>>;
  progress?(event: string, details: Record<string, unknown>): void;
};
export type AuditFinding = {
  key: string;
  entryId?: string;
  account?: string;
  rootAccount?: string;
  fundingStatus?: string;
  lastStreamCreditAt?: string;
  usedOnChain?: boolean;
  issues: string[];
  action: string;
};

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Audits the credit entries it is given. Coverage is bounded by what the Worker API exposes: accounts
 * come from the subgraph, so an account that was credited without ever streaming is not examined, and
 * per-account history indexes retain only the most recent 500 IDs.
 */
export async function auditLegacyStreams(deps: AuditDependencies) {
  const findings: AuditFinding[] = [];
  const counts = { scanned: 0, legacyStreams: 0, skippedDeposits: 0, skippedNewStreams: 0, reconciliationMismatches: 0, needsReview: 0 };
  for await (const key of deps.keys()) {
    counts.scanned += 1;
    if (counts.scanned === 1 || counts.scanned % 100 === 0) deps.progress?.("kv.audit.progress", { ...counts });
    const value = await deps.get(key);
    if (value && typeof value === "object" && "source" in value && value.source === "deposit") {
      counts.skippedDeposits += 1;
      continue;
    }
    const parsed = entrySchema.safeParse(value);
    if (!parsed.success || key !== `${CREDIT_PREFIX}${parsed.data.id}`) {
      findings.push({ key, issues: ["invalid_or_missing_credit_record"], action: "Inspect the raw KV record before deploying." });
      continue;
    }
    const entry = parsed.data;
    if (!STREAM_SOURCES.has(entry.source)) {
      findings.push({ key, entryId: entry.id, issues: ["unknown_credit_source"], action: "Review this record manually." });
      continue;
    }
    if (entry.streamCreditedThrough !== undefined) {
      counts.skippedNewStreams += 1;
      continue;
    }
    counts.legacyStreams += 1;
    deps.progress?.("kv.audit.legacy-entry", { scanned: counts.scanned, legacyStreams: counts.legacyStreams, fundingStatus: entry.fundingStatus });
    const profile = await deps.get(`user:${entry.account.toLowerCase()}`);
    const clock = profile && typeof profile === "object" && "lastStreamCreditAt" in profile ? profile.lastStreamCreditAt : undefined;
    const lastStreamCreditAt = typeof clock === "string" ? clock : undefined;
    const issues: string[] = [];
    if (clock !== undefined && (typeof clock !== "string" || !Number.isFinite(Date.parse(clock)))) issues.push("invalid_stream_clock");
    if (!lastStreamCreditAt) issues.push("missing_stream_clock");
    if (entry.account.toLowerCase() !== entry.rootAccount.toLowerCase()) issues.push("legacy_root_clock_may_be_mirrored");
    const usedOnChain = await deps.used(entry.id);
    const nonzero = BigInt(entry.totalCreditUsd) > 0n;
    if (BigInt(entry.principalUsd) + BigInt(entry.bonusUsd) !== BigInt(entry.totalCreditUsd)) issues.push("invalid_credit_total");
    let action = "Preserve the existing clock; historical under-credit before it needs separate reconciliation.";
    if (usedOnChain && entry.fundingStatus !== "funded") {
      issues.push("landed_deposit_not_recorded_as_funded");
      action = "Before the new cron, reconcile this landed deposit and its actual paid-through boundary; a new ID may pay an overlapping window.";
    } else if (!usedOnChain && nonzero && entry.fundingStatus === "funded") {
      issues.push("funded_in_kv_but_id_unused_on_chain");
      action = "Check bridge-disabled operation, the operator address, and historical funding before trusting this clock.";
    } else if (!usedOnChain && entry.fundingStatus !== "funded") {
      issues.push("unfunded_legacy_entry");
      action =
        "The new cron uses a different ID. Reconcile outstanding and bonus-cap accounting, and prevent later replay of this legacy entry before backfilling.";
    }
    if (!nonzero && entry.fundingStatus === "funded") {
      issues.push("legacy_zero_amount_ack_may_have_advanced_clock");
    }
    findings.push({
      key,
      entryId: entry.id,
      account: entry.account,
      rootAccount: entry.rootAccount,
      fundingStatus: entry.fundingStatus,
      lastStreamCreditAt,
      usedOnChain,
      issues,
      action
    });
  }
  // Reconciliation: what the subgraph says each account streamed up to its clock, against what KV
  // claims it credited. This is the check that surfaces accounting drift directly -- a legacy
  // profile reporting 6.2M G$ streamed against 7.1k G$ actually streamed fails here regardless of
  // which individual entries look healthy.
  deps.progress?.("kv.audit.reconciling", {});
  for (const row of (await deps.reconcile()).values()) {
    const drift = row.creditedWei - row.owedToClockWei;
    if (drift === 0n) continue;
    counts.reconciliationMismatches += 1;
    // Drift priced as seconds of the account's own flow, which is what makes a finding readable. The
    // credit path truncates to whole seconds, so a handful of seconds is accumulated rounding; the
    // accounts that matter are off by months or decades of flow, and no epsilon has to be guessed to
    // tell the two apart.
    const driftSeconds =
      row.maxFlowRateWeiPerSecond && row.maxFlowRateWeiPerSecond > 0n ? ` = ${abs(drift) / row.maxFlowRateWeiPerSecond}s of flow at the account's peak rate` : "";
    findings.push({
      key: `user:${row.account}`,
      account: row.account,
      lastStreamCreditAt: row.lastStreamCreditAt,
      issues: [drift > 0n ? "credited_more_than_streamed" : "credited_less_than_streamed"],
      action:
        drift > 0n
          ? `KV credits ${row.creditedWei} wei against ${row.owedToClockWei} wei streamed to the clock (over by ${drift}${driftSeconds}). Correct the profile totals before trusting them.`
          : `KV credits ${row.creditedWei} wei against ${row.owedToClockWei} wei streamed to the clock (short by ${-drift}${driftSeconds}). Reconcile the shortfall; the clock may have advanced past unpaid time.`
    });
  }

  counts.needsReview = findings.filter((finding) => finding.issues.length > 0).length;
  deps.progress?.("kv.audit.complete", { ...counts });
  return {
    readOnly: true,
    counts,
    warnings: [
      "KV is eventually consistent: pause ingestion and cron, wait for writes to propagate, and rerun before reconciliation.",
      "Accounts are taken from the Superfluid subgraph and records from the Worker API; this is not a full KV key scan. Accounts that never streamed, and entries beyond the newest 500 per account, are not examined.",
      "A funding block timestamp is NOT a paid-through boundary; legacy entries did not record that boundary.",
      "No records, totals, bonus caps, stream clocks, or closed-period cursors are changed.",
      "Reconciliation compares the subgraph against the API; it does not prove a deposit landed. `usedDepositIds` does that."
    ],
    findings
  };
}

/**
 * Reads the backend's own public API instead of Cloudflare KV.
 *
 * Everything the audit needs is already exposed -- profiles and credit history -- so it needs no
 * Cloudflare account, namespace id or API token, and it sees exactly what the deployed Worker serves
 * rather than raw storage.
 */
export class WorkerApiReader {
  constructor(
    private readonly baseUrl: string,
    private readonly request: typeof fetch = fetch
  ) {}

  private async getJson(path: string): Promise<unknown> {
    // A browser-ish agent: some edge configurations reject the default agent of a bare HTTP client.
    const response = await this.request(new URL(path, this.baseUrl), { headers: { accept: "application/json", "user-agent": "antseed-audit" } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`API read failed (${response.status})`);
    return response.json();
  }

  async profile(account: string): Promise<{ totalGDStreamedWei?: string; lastStreamCreditAt?: string } | undefined> {
    const body = (await this.getJson(`/v1/accounts/${encodeURIComponent(account)}/profile`)) as { profile?: Record<string, unknown> } | undefined;
    return body?.profile as { totalGDStreamedWei?: string; lastStreamCreditAt?: string } | undefined;
  }

  /** Every credit entry the Worker has indexed for this account. */
  async *creditHistory(account: string): AsyncIterable<unknown> {
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const page = (await this.getJson(`/v1/accounts/${encodeURIComponent(account)}/credit-history?limit=${limit}&offset=${offset}`)) as
        | { items?: unknown[]; hasMore?: boolean }
        | undefined;
      for (const item of page?.items ?? []) yield item;
      if (!page?.hasMore || !page.items?.length) return;
    }
  }
}

const OPERATOR_ABI = ["function usedDepositIds(bytes32) view returns (bool)"];

function logProgress(event: string, details: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }));
}

/** Remote error objects can contain credentials and authenticated URLs. */
export function getAuditErrorMessage(error: unknown): string {
  const messages = [
    "Expected --output <new-report.json>; use --help",
    "Missing ANTSEED_API_URL or operator address",
    "Invalid ANTSEED_API_URL; expected an http(s) URL for the deployed Worker",
    "Invalid ANTSEED_FUNDING_RPC_URL; expected an http(s) Base mainnet endpoint",
    "Expected a safe unsigned block number",
    "Operator contract or block unavailable",
    "Audit RPC must use Base mainnet",
    "Finalized block unavailable",
    "Superfluid subgraph unavailable; reconciliation cannot be trusted",
    "Audit block changed; rerun the audit"
  ];
  if (error instanceof Error && messages.includes(error.message)) return error.message.replace(/[\r\n]/g, "_");
  if (error instanceof Error && /^API read failed \(\d{3}\)$/.test(error.message)) return error.message;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const codes = ["EEXIST", "ENOENT", "EACCES", "ENOSPC", "NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT", "CALL_EXCEPTION", "BAD_DATA", "ECONNREFUSED", "ENOTFOUND"];
  return typeof code === "string" && codes.includes(code) ? `Operation failed (${code})` : "Operation failed (remote details omitted to protect credentials)";
}

type WranglerAuditConfig = {
  vars?: Record<string, unknown>;
};

/** Explicit environment values override deployment configuration and Base defaults. */
export function resolveAuditConfig(wrangler: WranglerAuditConfig, env: NodeJS.ProcessEnv = process.env) {
  const configString = (name: string) => (typeof wrangler.vars?.[name] === "string" ? (wrangler.vars[name] as string) : undefined);
  return {
    // The deployed hostname is not derivable from the Worker name (it depends on the account's
    // workers.dev subdomain or a custom route), so it has to be supplied.
    apiBaseUrl: env.ANTSEED_API_URL || configString("ANTSEED_API_URL"),
    rpcUrl: env.ANTSEED_FUNDING_RPC_URL || configString("ANTSEED_FUNDING_RPC_URL") || base.rpcUrls.default.http[0],
    operatorAddress: env.ANTSEED_FUNDING_VAULT_ADDRESS || configString("ANTSEED_FUNDING_VAULT_ADDRESS"),
    celoVaultAddress: env.CELO_VAULT_ADDRESS || configString("CELO_VAULT_ADDRESS"),
    gdSuperTokenAddress: env.CELO_GD_SUPERTOKEN_ADDRESS || configString("CELO_GD_SUPERTOKEN_ADDRESS"),
    subgraphUrl: env.SUPERFLUID_SUBGRAPH_URL || configString("SUPERFLUID_SUBGRAPH_URL")
  };
}

/**
 * Everything the audit reads, gathered from the subgraph and the Worker API.
 *
 * The subgraph is the authority on which accounts have ever streamed, so it -- not a KV key listing --
 * defines the accounts to examine. For each one the API supplies the profile and the indexed credit
 * entries, which together give both halves of the audit:
 *
 *  - `records`: the legacy entries to check against `usedDepositIds`, keyed as the audit expects.
 *  - `reconciliations`: what Superfluid says the account streamed up to its own stream clock, against
 *    what the profile claims was credited. Measured to `lastStreamCreditAt` rather than to now, because
 *    time after the clock is simply not yet credited -- normal, and not a finding.
 *
 * Uses the backend's own `fetchStreamPeriods` and `streamOwedWei`, so the audit cannot drift from the
 * code it is auditing.
 */
async function loadFromApi(
  config: ReturnType<typeof resolveAuditConfig>,
  api: WorkerApiReader,
  progress: (event: string, details?: Record<string, unknown>) => void
): Promise<{ records: Map<string, unknown>; reconciliations: Map<string, StreamedReconciliation> }> {
  const records = new Map<string, unknown>();
  const reconciliations = new Map<string, StreamedReconciliation>();
  if (!config.celoVaultAddress || !config.gdSuperTokenAddress) {
    progress("reconcile.skipped", { reason: "missing_celo_vault_or_supertoken" });
    return { records, reconciliations };
  }
  const snapshot = await fetchStreamPeriods(
    {
      CELO_VAULT_ADDRESS: config.celoVaultAddress,
      CELO_GD_SUPERTOKEN_ADDRESS: config.gdSuperTokenAddress,
      SUPERFLUID_SUBGRAPH_URL: config.subgraphUrl
    } as unknown as RuntimeConfig,
    0
  );
  if (!snapshot) throw new Error("Superfluid subgraph unavailable; reconciliation cannot be trusted");

  const periodsByAccount = new Map<string, typeof snapshot.periods>();
  for (const period of snapshot.periods) {
    const list = periodsByAccount.get(period.account) ?? [];
    list.push(period);
    periodsByAccount.set(period.account, list);
  }
  progress("reconcile.accounts", { accounts: periodsByAccount.size });

  for (const [account, periods] of periodsByAccount) {
    const profile = await api.profile(account);
    records.set(`user:${account}`, profile);
    const lastStreamCreditAt = profile?.lastStreamCreditAt;
    const clock = lastStreamCreditAt ? Math.floor(Date.parse(lastStreamCreditAt) / 1000) : 0;
    reconciliations.set(account, {
      account,
      owedToClockWei: Number.isFinite(clock) ? streamOwedWei(periods, 0, clock) : 0n,
      creditedWei: BigInt(profile?.totalGDStreamedWei ?? "0"),
      maxFlowRateWeiPerSecond: periods.reduce((peak, period) => (period.flowRateWeiPerSecond > peak ? period.flowRateWeiPerSecond : peak), 0n),
      lastStreamCreditAt
    });
    let entries = 0;
    for await (const item of api.creditHistory(account)) {
      const entryId = item && typeof item === "object" && "id" in item && typeof item.id === "string" ? item.id : undefined;
      if (!entryId) continue;
      records.set(`${CREDIT_PREFIX}${entryId}`, item);
      entries += 1;
    }
    progress("api.account.loaded", { entries, hasProfile: Boolean(profile) });
  }
  return { records, reconciliations };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`Read-only legacy stream audit (no transactions or KV writes).
Usage: yarn audit:legacy-streams --output <new-report.json>   (npm: npm run audit:legacy-streams -- --output <file>)
Required environment (a backend/.env is loaded automatically; real environment variables win):
  ANTSEED_API_URL (base URL of the deployed Worker, e.g. https://<worker>.workers.dev)
Defaults:
  ANTSEED_FUNDING_VAULT_ADDRESS: vars in wrangler.toml
  ANTSEED_FUNDING_RPC_URL: Wrangler vars, then Base public RPC
  CELO_VAULT_ADDRESS / CELO_GD_SUPERTOKEN_ADDRESS / SUPERFLUID_SUBGRAPH_URL: vars in wrangler.toml
Environment values override all defaults.
Optional: TO_BLOCK (defaults to finalized). Deposit landing is checked with usedDepositIds; streamed-vs-credited comes from the Superfluid subgraph.\nAccounts come from the subgraph and records from the Worker API, so no Cloudflare credentials are needed.
Optional: --verbose prints the raw error on failure (may reveal credentials; local use only).
Exit codes: 0 = no flagged records, 2 = review required, 1 = audit failed.
Pause cron and event ingestion for a stable audit. Reports contain wallet and credit data.
Legacy entries lack window-end timestamps: repairs must be reviewed, not guessed from funding time.`);
    return;
  }
  // Load `.env` for local runs. Variables already in the environment win, so CI and production are
  // unaffected, and a missing file is not an error -- it just means the environment is supplied some
  // other way. Without this every invocation needs `set -a; . ./.env; set +a` first.
  try {
    process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
  } catch {
    // No .env, or unreadable: fall back to the ambient environment.
  }
  logProgress("audit.start", { readOnly: true });
  // `npm run x -- --output f` needs the separator; Yarn Berry forwards it literally, so accept both.
  const args = process.argv.slice(2).filter((arg) => arg !== "--" && arg !== "--verbose");
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) throw new Error("Expected --output <new-report.json>; use --help");
  logProgress("config.loading");
  const { experimental_readRawConfig } = await import("wrangler");
  const { rawConfig } = experimental_readRawConfig({ config: fileURLToPath(new URL("../wrangler.toml", import.meta.url)) });
  const config = resolveAuditConfig(rawConfig as WranglerAuditConfig);
  if (!config.apiBaseUrl || !config.operatorAddress) throw new Error("Missing ANTSEED_API_URL or operator address");
  // Checked explicitly: an unset or placeholder URL otherwise surfaces as the generic sanitised
  // error, which is indistinguishable from a credential problem.
  if (!/^https?:\/\//.test(config.apiBaseUrl)) throw new Error("Invalid ANTSEED_API_URL; expected an http(s) URL for the deployed Worker");
  if (!/^https?:\/\//.test(config.rpcUrl)) throw new Error("Invalid ANTSEED_FUNDING_RPC_URL; expected an http(s) Base mainnet endpoint");
  const api = new WorkerApiReader(config.apiBaseUrl);
  logProgress("config.loaded");
  const rpc = new JsonRpcProvider(config.rpcUrl);
  try {
    const operatorAddress = getAddress(config.operatorAddress);
    const operator = new Contract(operatorAddress, OPERATOR_ABI, rpc);
    logProgress("chain.resolving-range");
    const toBlock = process.env.TO_BLOCK ? integer(process.env.TO_BLOCK) : (await rpc.getBlock("finalized"))?.number;
    if (toBlock === undefined) throw new Error("Finalized block unavailable");
    const block = await rpc.getBlock(toBlock);
    if (!block?.hash || (await rpc.getCode(operatorAddress, toBlock)) === "0x") throw new Error("Operator contract or block unavailable");
    const chainId = (await rpc.getNetwork()).chainId.toString();
    if (chainId !== String(base.id)) throw new Error("Audit RPC must use Base mainnet");
    logProgress("reconcile.start", { chainId, toBlock });
    // Streamed-vs-credited comes from the subgraph and the Worker API; no explorer, no block scan.
    // The only chain fact the audit needs is whether each legacy deposit id actually landed, which is
    // one `usedDepositIds` call per entry.
    const { records, reconciliations } = await loadFromApi(config, api, logProgress);
    logProgress("kv.audit.start", { accountsReconciled: reconciliations.size, records: records.size });
    const report = await auditLegacyStreams({
      async *keys() {
        for (const key of records.keys()) if (key.startsWith(CREDIT_PREFIX)) yield key;
      },
      get: async (key) => records.get(key),
      used: async (entryId) => Boolean(await operator.usedDepositIds(id(entryId), { blockTag: toBlock })),
      reconcile: async () => reconciliations,
      progress: logProgress
    });
    logProgress("chain.verifying-block");
    if ((await rpc.getBlock(toBlock))?.hash !== block.hash) throw new Error("Audit block changed; rerun the audit");
    logProgress("report.writing");
    await writeFile(
      resolve(args[1]),
      JSON.stringify({ generatedAt: new Date().toISOString(), chainId, operatorAddress, toBlock, blockHash: block.hash, ...report }, null, 2),
      { flag: "wx", mode: 0o600 }
    );
    console.log(JSON.stringify(report.counts));
    process.exitCode = report.counts.needsReview > 0 ? 2 : 0;
    logProgress("audit.complete", { ...report.counts, exitCode: process.exitCode, readOnly: true });
  } finally {
    rpc.destroy();
  }
}

function integer(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Expected a safe unsigned block number");
  return Number(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const message = getAuditErrorMessage(error);
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), event: "audit.failed", message, remoteWrites: false }));
    // The message above is deliberately sanitised, because remote errors can carry credentials and
    // authenticated URLs. That also hides ordinary misconfiguration, so `--verbose` prints the raw
    // error for local diagnosis. Never use it where the output is shared or logged.
    if (process.argv.includes("--verbose")) console.error(error);
    process.exitCode = 1;
  });
}
