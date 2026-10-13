import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Contract, Interface, JsonRpcProvider, getAddress, id } from "ethers";
import { base } from "viem/chains";
import { z } from "zod";

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
export type FundingEvidence = {
  buyer: string;
  principalUsd: string;
  bonusUsd: string;
  txHash: string;
  blockNumber: number;
  fundedAt: string;
};
export type AuditDependencies = {
  keys(): AsyncIterable<string>;
  get(key: string): Promise<unknown>;
  used(entryId: string): Promise<boolean>;
  evidence(entryId: string): Promise<FundingEvidence | undefined>;
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
  evidence?: FundingEvidence;
  issues: string[];
  action: string;
};

/** Audit every credit key; account history indexes retain only the most recent 500 IDs. */
export async function auditLegacyStreams(deps: AuditDependencies) {
  const findings: AuditFinding[] = [];
  const counts = { scanned: 0, legacyStreams: 0, skippedDeposits: 0, skippedNewStreams: 0, needsReview: 0 };
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
    const evidence = usedOnChain ? await deps.evidence(entry.id) : undefined;
    const nonzero = BigInt(entry.totalCreditUsd) > 0n;
    if (BigInt(entry.principalUsd) + BigInt(entry.bonusUsd) !== BigInt(entry.totalCreditUsd)) issues.push("invalid_credit_total");
    if (usedOnChain && !evidence) issues.push("used_id_without_funding_event_in_scan_range");
    if (evidence) {
      if (evidence.buyer.toLowerCase() !== (entry.buyerAddress ?? entry.account).toLowerCase()) issues.push("funding_buyer_mismatch");
      if (evidence.principalUsd !== entry.principalUsd || evidence.bonusUsd !== entry.bonusUsd) issues.push("funding_amount_mismatch");
    }
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
      evidence,
      issues,
      action
    });
  }
  counts.needsReview = findings.filter((finding) => finding.issues.length > 0).length;
  deps.progress?.("kv.audit.complete", { ...counts });
  return {
    readOnly: true,
    counts,
    warnings: [
      "KV is eventually consistent: pause ingestion and cron, wait for writes to propagate, and rerun before reconciliation.",
      "A funding block timestamp is NOT a paid-through boundary; legacy entries did not record that boundary.",
      "No records, totals, bonus caps, stream clocks, or closed-period cursors are changed."
    ],
    findings
  };
}

export class CloudflareKvReader {
  constructor(
    private readonly accountId: string,
    private readonly namespaceId: string,
    private readonly token: string,
    private readonly request: typeof fetch = fetch
  ) {}

  private url(path: string) {
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/storage/kv/namespaces/${encodeURIComponent(this.namespaceId)}/${path}`;
  }

  /** Traverse the namespace rather than truncated per-account credit indexes. */
  async *keys(): AsyncIterable<string> {
    let cursor = "";
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams({ prefix: CREDIT_PREFIX, limit: "1000" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.request(this.url(`keys?${query}`), { headers: { authorization: `Bearer ${this.token}` } });
      if (!response.ok) throw new Error(`KV list failed (${response.status})`);
      const page = z
        .object({
          success: z.literal(true),
          result: z.array(z.object({ name: z.string() })),
          result_info: z.object({ cursor: z.string().optional() }).optional()
        })
        .parse(await response.json());
      for (const key of page.result) yield key.name;
      cursor = page.result_info?.cursor ?? "";
      if (cursor && seen.has(cursor)) throw new Error("KV pagination repeated a cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }

  /** Read the exact value without logging the API token or raw request errors. */
  async get(key: string): Promise<unknown> {
    const response = await this.request(this.url(`values/${encodeURIComponent(key)}`), { headers: { authorization: `Bearer ${this.token}` } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`KV read failed (${response.status})`);
    return response.json();
  }
}

const OPERATOR_ABI = [
  "function usedDepositIds(bytes32) view returns (bool)",
  "event BuyerDepositFundedWithId(address indexed buyer,uint256 principal,uint256 bonus,string id)"
];

/** Paginate Etherscan results over one fixed block range. */
export async function* fetchFundingLogs(
  apiKey: string,
  operatorAddress: string,
  fromBlock: number,
  toBlock: number,
  request: typeof fetch = fetch,
  progress?: AuditDependencies["progress"]
) {
  const url = new URL("https://api.etherscan.io/v2/api");
  const topic = id("BuyerDepositFundedWithId(address,uint256,uint256,string)");
  const hexInteger = z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .transform((value) => Number(BigInt(value)))
    .refine((value) => Number.isSafeInteger(value) && value >= 0);
  const schema = z.array(
    z.object({
      blockNumber: hexInteger,
      transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      data: z.string().regex(/^0x[0-9a-fA-F]*$/),
      topics: z.array(
        z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/)
          .or(z.null())
      ),
      logIndex: hexInteger
    })
  );
  const pageSize = 1000;
  url.search = new URLSearchParams({
    chainid: String(base.id),
    module: "logs",
    action: "getLogs",
    address: getAddress(operatorAddress),
    fromBlock: String(fromBlock),
    toBlock: String(toBlock),
    topic0: topic,
    offset: String(pageSize),
    apikey: apiKey
  }).toString();
  const seen = new Set<string>();
  let pageNumber = 0;
  while (true) {
    url.searchParams.set("page", String(++pageNumber));
    progress?.("chain.scan.page.start", { page: pageNumber });
    const response = await request(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      console.error(await response.text());
      throw new Error(`Etherscan logs failed (${response.status})`);
    }
    const body = z.object({ status: z.string(), message: z.string(), result: z.unknown() }).parse(await response.json());
    // Etherscan signals an empty range with status 0 / "No records found" and a `[]` result, which is
    // a legitimate answer, not a failure. A genuine rejection (bad key, rate limit) carries "NOTOK"
    // and a string result, so only that must fail the audit closed.
    const emptyRange = body.status === "0" && body.message === "No records found";
    if (!emptyRange && body.message !== "OK")
      throw new Error("Etherscan API rejected logs request; check API key, Base access, and rate limits");
    const logs = schema.parse(body.result);
    for (const log of logs) {
      if (log.blockNumber < fromBlock || log.blockNumber > toBlock || log.topics[0]?.toLowerCase() !== topic)
        throw new Error("Etherscan returned logs outside the requested filter");
      const identity = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
      if (seen.has(identity)) throw new Error("Etherscan pagination returned duplicate logs");
      seen.add(identity);
      yield {
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        index: log.logIndex,
        data: log.data,
        topics: log.topics
      };
    }
    progress?.("chain.scan.page.complete", { page: pageNumber, logs: logs.length });
    if (logs.length < pageSize) break;
  }
}

let auditStage = "startup";

function logProgress(event: string, details: Record<string, unknown> = {}) {
  auditStage = event;
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }));
}

/** Remote error objects can contain credentials and authenticated URLs. */
export function getAuditErrorMessage(error: unknown): string {
  const messages = [
    "Expected --output <new-report.json>; use --help",
    "Missing Cloudflare account, KV namespace, or operator address",
    "Missing CLOUDFLARE_API_TOKEN",
    "Missing ETHERSCAN_API_KEY",
    "Ambiguous ANTSEED_KV namespace",
    "Expected a safe unsigned block number",
    "Invalid or unavailable finalized block range",
    "Operator contract or block unavailable",
    "Etherscan pagination returned duplicate logs",
    "Etherscan API rejected logs request; check API key, Base access, and rate limits",
    "Etherscan returned logs outside the requested filter",
    "Audit RPC must use Base mainnet",
    "Could not decode funding log",
    "Duplicate deposit ID in event history",
    "Funding event block is unavailable or reorged",
    "Audit block changed; rerun the audit",
    "KV pagination repeated a cursor"
  ];
  console.log(error);
  if (error instanceof Error && messages.includes(error.message)) return error.message.replace(/[\r\n]/g, "_");
  if (error instanceof Error && /^(KV (list|read)|Etherscan logs) failed \(\d{3}\)$/.test(error.message)) return error.message;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const codes = ["EEXIST", "ENOENT", "EACCES", "ENOSPC", "NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT", "CALL_EXCEPTION", "BAD_DATA", "ECONNREFUSED", "ENOTFOUND"];
  return typeof code === "string" && codes.includes(code) ? `Operation failed (${code})` : "Operation failed (remote details omitted to protect credentials)";
}

type WranglerAuditConfig = {
  account_id?: string;
  vars?: Record<string, unknown>;
  kv_namespaces?: Array<{ binding: string; id?: string }>;
};

/** Explicit environment values override deployment configuration and Base defaults. */
export function resolveAuditConfig(wrangler: WranglerAuditConfig, env: NodeJS.ProcessEnv = process.env) {
  const namespaces = wrangler.kv_namespaces?.filter((binding) => binding.binding === "ANTSEED_KV") ?? [];
  if (!env.ANTSEED_KV_NAMESPACE_ID && namespaces.length > 1) throw new Error("Ambiguous ANTSEED_KV namespace");
  const configString = (name: string) => (typeof wrangler.vars?.[name] === "string" ? (wrangler.vars[name] as string) : undefined);
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID || wrangler.account_id,
    namespaceId: env.ANTSEED_KV_NAMESPACE_ID || namespaces[0]?.id,
    rpcUrl: env.ANTSEED_FUNDING_RPC_URL || configString("ANTSEED_FUNDING_RPC_URL") || base.rpcUrls.default.http[0],
    operatorAddress: env.ANTSEED_FUNDING_VAULT_ADDRESS || configString("ANTSEED_FUNDING_VAULT_ADDRESS"),
    // Matches the historical funding scan in migrate-buyer-accounting.ts.
    fromBlock: integer(env.FROM_BLOCK || configString("FROM_BLOCK") || "48055111")
  };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`Read-only legacy stream audit (no transactions or KV writes).
Usage: npm run audit:legacy-streams -- --output <new-report.json>
Required environment:
  CLOUDFLARE_API_TOKEN (KV read permission only)
  ETHERSCAN_API_KEY (Etherscan V2 with Base access)
  CLOUDFLARE_ACCOUNT_ID (unless account_id is configured in Wrangler)
Defaults:
  ANTSEED_KV_NAMESPACE_ID: ANTSEED_KV binding in wrangler.toml
  ANTSEED_FUNDING_VAULT_ADDRESS: vars in wrangler.toml
  ANTSEED_FUNDING_RPC_URL: Wrangler vars, then Base public RPC
  FROM_BLOCK: Wrangler vars, then 48055111 (existing historical funding scan)
Environment values override all defaults; override FROM_BLOCK for a different deployment.
Optional: TO_BLOCK (defaults to finalized). Funding logs use Etherscan V2 result pages on Base (8453).
Exit codes: 0 = no flagged records, 2 = review required, 1 = audit failed.
Pause cron and event ingestion for a stable audit. Reports contain wallet and credit data.
Legacy entries lack window-end timestamps: repairs must be reviewed, not guessed from funding time.`);
    return;
  }
  logProgress("audit.start", { readOnly: true });
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) throw new Error("Expected --output <new-report.json>; use --help");
  logProgress("config.loading");
  const { experimental_readRawConfig } = await import("wrangler");
  const { rawConfig } = experimental_readRawConfig({ config: fileURLToPath(new URL("../wrangler.toml", import.meta.url)) });
  const config = resolveAuditConfig(rawConfig as WranglerAuditConfig);
  if (!config.accountId || !config.namespaceId || !config.operatorAddress) throw new Error("Missing Cloudflare account, KV namespace, or operator address");
  const kv = new CloudflareKvReader(config.accountId, config.namespaceId, required("CLOUDFLARE_API_TOKEN"));
  const etherscanApiKey = required("ETHERSCAN_API_KEY");
  logProgress("config.loaded", { fromBlock: config.fromBlock });
  const rpc = new JsonRpcProvider(config.rpcUrl);
  try {
    const operatorAddress = getAddress(config.operatorAddress);
    const operator = new Contract(operatorAddress, OPERATOR_ABI, rpc);
    const fromBlock = config.fromBlock;
    logProgress("chain.resolving-range");
    const toBlock = process.env.TO_BLOCK ? integer(process.env.TO_BLOCK) : (await rpc.getBlock("finalized"))?.number;
    if (toBlock === undefined || toBlock < fromBlock) throw new Error("Invalid or unavailable finalized block range");
    const block = await rpc.getBlock(toBlock);
    if (!block?.hash || (await rpc.getCode(operatorAddress, toBlock)) === "0x") throw new Error("Operator contract or block unavailable");
    const chainId = (await rpc.getNetwork()).chainId.toString();
    if (chainId !== String(base.id)) throw new Error("Audit RPC must use Base mainnet");
    logProgress("chain.scan.start", { chainId, fromBlock, toBlock, source: "etherscan" });
    const iface = new Interface(OPERATOR_ABI);
    const evidence = new Map<string, FundingEvidence>();
    const timestamps = new Map<number, string>();
    for await (const log of fetchFundingLogs(etherscanApiKey, operatorAddress, fromBlock, toBlock, fetch, logProgress)) {
      // const receipt = await rpc.getTransactionReceipt(log.transactionHash);
      // const confirmed = receipt?.logs.find((item) => item.index === log.index && item.address.toLowerCase() === operatorAddress.toLowerCase());
      // if (
      //   !receipt ||
      //   receipt.status !== 1 ||
      //   receipt.blockNumber !== log.blockNumber ||
      //   !confirmed ||
      //   confirmed.data !== log.data ||
      //   JSON.stringify(confirmed.topics) !== JSON.stringify(log.topics)
      // )
      //   throw new Error("Funding event block is unavailable or reorged");
      // Etherscan pads absent topics with null; drop them so the decoder sees the real topic list.
      // Narrowed rather than mutated, so the array is typed `string[]` for `parseLog`.
      const topics = log.topics.filter((topic): topic is string => topic !== null);
      const event = iface.parseLog({ topics, data: log.data });
      if (!event) throw new Error("Could not decode funding log");
      const entryId = event.args.id as string;
      if (evidence.has(entryId)) throw new Error("Duplicate deposit ID in event history");
      let fundedAt = timestamps.get(log.blockNumber);
      if (!fundedAt) {
        const fundedBlock = await rpc.getBlock(log.blockNumber);
        if (!fundedBlock) throw new Error("Funding event block is unavailable or reorged");
        fundedAt = new Date(fundedBlock.timestamp * 1000).toISOString();
        timestamps.set(log.blockNumber, fundedAt);
      }
      evidence.set(entryId, {
        buyer: event.args.buyer,
        principalUsd: event.args.principal.toString(),
        bonusUsd: event.args.bonus.toString(),
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        fundedAt
      });
    }
    logProgress("kv.audit.start", { fundingEvents: evidence.size });
    const report = await auditLegacyStreams({
      keys: () => kv.keys(),
      get: (key) => kv.get(key),
      used: async (entryId) => Boolean(await operator.usedDepositIds(id(entryId), { blockTag: toBlock })),
      evidence: async (entryId) => evidence.get(entryId),
      progress: logProgress
    });
    logProgress("chain.verifying-block");
    if ((await rpc.getBlock(toBlock))?.hash !== block.hash) throw new Error("Audit block changed; rerun the audit");
    logProgress("report.writing");
    await writeFile(
      resolve(args[1]),
      JSON.stringify({ generatedAt: new Date().toISOString(), chainId, operatorAddress, fromBlock, toBlock, blockHash: block.hash, ...report }, null, 2),
      { flag: "wx", mode: 0o600 }
    );
    console.log(JSON.stringify(report.counts));
    process.exitCode = report.counts.needsReview > 0 ? 2 : 0;
    logProgress("audit.complete", { ...report.counts, exitCode: process.exitCode, readOnly: true });
  } finally {
    rpc.destroy();
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function integer(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Expected a safe unsigned block number");
  return Number(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const message = getAuditErrorMessage(error);
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), event: "audit.failed", stage: auditStage, message, remoteWrites: false }));
    process.exitCode = 1;
  });
}
