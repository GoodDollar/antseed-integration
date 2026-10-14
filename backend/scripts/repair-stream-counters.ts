import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/**
 * Rebuilds a profile's G$ and outstanding counters from the account's own credit entries.
 *
 * Entries written before the `credited` guard landed added their amounts to the profile totals whether
 * funding succeeded or not, so a failed entry inflated the counters permanently. One failed window
 * carrying 6,191,029 G$ is what made an account report 6.2M G$ deposited against $4.25 of granted
 * credit. The guard stops new drift; it cannot unwind what is already stored, so the totals have to be
 * recomputed from the entries that actually funded.
 *
 * Reads go through the Worker's public API, so inspecting needs no Cloudflare credentials. Writes have
 * no public endpoint: `--apply` shells out to `wrangler kv key put`, and a dry run instead emits a
 * payload for the REST bulk endpoint.
 *
 * This reconciles the counters with the ENTRIES, not with Superfluid. Some funded legacy entries
 * over-state what actually streamed, and those deposits already landed on Base, so a residual drift
 * against the subgraph survives this repair by design -- `audit:legacy-streams` will still report it.
 */

/** Counters this script rebuilds. Everything else on the profile is preserved byte-for-byte. */
const REBUILT = ["totalGDStreamedWei", "totalGdDepositedWei", "totalOutstandingFundingUsd"] as const;

const unsigned = z.string().regex(/^\d+$/);
const ProfileSchema = z
  .object({
    account: z.string(),
    totalGDStreamedWei: unsigned,
    totalGdDepositedWei: unsigned,
    totalOutstandingFundingUsd: unsigned,
    totalPrincipalUsd: unsigned,
    totalBonusUsd: unsigned,
    lastStreamCreditAt: z.string().optional()
  })
  .passthrough();
const EntrySchema = z
  .object({
    id: z.string().min(1),
    source: z.string(),
    fundingStatus: z.enum(["pending", "failed", "funded"]),
    gdAmountWei: unsigned,
    totalCreditUsd: unsigned
  })
  .passthrough();
const HistoryPageSchema = z.object({ items: z.array(EntrySchema), hasMore: z.boolean().optional() });

export type Profile = z.infer<typeof ProfileSchema>;
export type Entry = z.infer<typeof EntrySchema>;

/**
 * The counters as the entries imply them. Mirrors `markFundingResult`: only a funded entry adds to the
 * lifetime totals, and only a stream-sourced one adds to the streamed total. An entry still pending is
 * owed but unpaid, which is exactly what the outstanding balance means.
 */
export function rebuildCounters(entries: Entry[]): Record<(typeof REBUILT)[number], string> {
  const sum = (rows: Entry[], field: "gdAmountWei" | "totalCreditUsd") => rows.reduce((total, row) => total + BigInt(row[field]), 0n);
  const funded = entries.filter((entry) => entry.fundingStatus === "funded" && BigInt(entry.totalCreditUsd) > 0n);
  return {
    totalGDStreamedWei: sum(
      funded.filter((entry) => entry.source.startsWith("stream")),
      "gdAmountWei"
    ).toString(),
    totalGdDepositedWei: sum(funded, "gdAmountWei").toString(),
    totalOutstandingFundingUsd: sum(
      entries.filter((entry) => entry.fundingStatus === "pending"),
      "totalCreditUsd"
    ).toString()
  };
}

/**
 * The repaired profile, or undefined when the counters already agree with the entries.
 *
 * `lastStreamCreditAt` is carried through untouched: it is the live stream clock, and moving it
 * backwards would make the cron re-credit history. `totalPrincipalUsd` and `totalBonusUsd` are
 * untouched too -- they record credit actually granted, which the operator contract mirrors on Base, so
 * KV must not be the one to disagree.
 */
export function repairProfile(profile: Profile, entries: Entry[], now: string): Profile | undefined {
  const rebuilt = rebuildCounters(entries);
  if (REBUILT.every((field) => profile[field] === rebuilt[field])) return undefined;
  return { ...profile, ...rebuilt, updatedAt: now };
}

export type ApiReader = {
  profile(account: string): Promise<Profile>;
  entries(account: string): Promise<Entry[]>;
};

/** Reads profiles and the full credit history from the deployed Worker's public endpoints. */
export function workerApi(baseUrl: string, request: typeof fetch = fetch): ApiReader {
  const getJson = async (path: string): Promise<unknown> => {
    const response = await request(new URL(path, baseUrl), { headers: { accept: "application/json", "user-agent": "antseed-repair" } });
    if (!response.ok) throw new Error(`API read failed (${response.status})`);
    return response.json();
  };
  return {
    async profile(account) {
      const body = z.object({ profile: ProfileSchema }).parse(await getJson(`/v1/accounts/${encodeURIComponent(account)}/profile`));
      return body.profile;
    },
    async entries(account) {
      const all: Entry[] = [];
      // 100 is the endpoint's own cap; asking for more is rejected rather than clamped.
      for (let offset = 0; ; offset += 100) {
        const page = HistoryPageSchema.parse(await getJson(`/v1/accounts/${encodeURIComponent(account)}/credit-history?limit=100&offset=${offset}`));
        all.push(...page.items);
        if (!page.hasMore || page.items.length === 0) return all;
      }
    }
  };
}

const HELP = `Rebuild profile G$ and outstanding counters from an account's funded credit entries.
Usage: yarn repair:stream-counters <account>... [--apply]

Reads the deployed Worker's public API; no Cloudflare credentials are needed for a dry run.
  ANTSEED_API_URL             base URL of the Worker (required)
  ANTSEED_KV_NAMESPACE_ID     ANTSEED_KV namespace id (required only with --apply)

Without --apply nothing is written: the diff is printed and the writes are emitted to
kv-bulk.json for the Cloudflare REST bulk endpoint. With --apply each profile is written
through \`wrangler kv key put --remote\`, which needs Node 22+ and a login on the account
that owns the namespace.

Rebuilt:   totalGDStreamedWei, totalGdDepositedWei, totalOutstandingFundingUsd
Preserved: lastStreamCreditAt (the live stream clock), totalPrincipalUsd, totalBonusUsd,
           streamFlowRateWeiPerSecond, and every other field

The scheduled run does a read-modify-write on these same keys every 6 hours (00:00, 06:00,
12:00, 18:00 UTC). Do not apply next to a tick, or one write will clobber the other.

Counters are reconciled against the ENTRIES, not against Superfluid: some funded legacy
entries over-state what streamed and those deposits already landed, so audit:legacy-streams
will still report a small residual drift afterwards.`;

function formatAmount(raw: string, field: string): string {
  const scale = field.endsWith("Wei") ? 1e18 : 1e6;
  return `${(Number(raw) / scale).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${field.endsWith("Wei") ? "G$" : "USD"}`;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  // `npm run x -- --apply` needs the separator; Yarn Berry forwards it literally, so accept both.
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const apply = args.includes("--apply");
  const accounts = args.filter((arg) => /^0x[0-9a-fA-F]{40}$/.test(arg)).map((account) => account.toLowerCase());
  if (accounts.length === 0) throw new Error("Expected at least one 0x account; use --help");
  const baseUrl = process.env.ANTSEED_API_URL;
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new Error("ANTSEED_API_URL must be an http(s) URL for the deployed Worker");
  const namespaceId = process.env.ANTSEED_KV_NAMESPACE_ID;
  if (apply && !namespaceId) throw new Error("ANTSEED_KV_NAMESPACE_ID is required with --apply");

  const api = workerApi(baseUrl);
  const now = new Date().toISOString();
  const writes: Array<{ key: string; value: string }> = [];

  for (const account of accounts) {
    const [profile, entries] = await Promise.all([api.profile(account), api.entries(account)]);
    const funded = entries.filter((entry) => entry.fundingStatus === "funded").length;
    console.log(`\n=== ${account}  (${entries.length} entries, ${funded} funded) ===`);
    const repaired = repairProfile(profile, entries, now);
    if (!repaired) {
      console.log("  counters already agree with the entries; nothing to write");
      continue;
    }
    for (const field of REBUILT) {
      if (profile[field] === repaired[field]) continue;
      console.log(`  ${field}\n    before ${formatAmount(profile[field], field)}\n    after  ${formatAmount(repaired[field], field)}`);
    }
    console.log(`  lastStreamCreditAt preserved: ${profile.lastStreamCreditAt ?? "(none)"}`);
    writes.push({ key: `user:${account}`, value: JSON.stringify(repaired) });
  }

  if (writes.length === 0) {
    console.log("\nNothing to repair.");
    return;
  }
  if (!apply) {
    const path = resolve("kv-bulk.json");
    await writeFile(path, JSON.stringify(writes, null, 2), { mode: 0o600 });
    console.log(`\nDry run: nothing was written. ${writes.length} profile(s) staged in ${path}.
Apply with --apply, or in one REST call:

  curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces/$ANTSEED_KV_NAMESPACE_ID/bulk" \\
    -H "authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" --data @kv-bulk.json`);
    return;
  }
  const { execFileSync } = await import("node:child_process");
  for (const write of writes) {
    execFileSync("wrangler", ["kv", "key", "put", "--remote", "--namespace-id", namespaceId!, write.key, write.value], { stdio: "inherit" });
    console.log(`  wrote ${write.key}`);
  }
  console.log(`\nApplied ${writes.length} profile(s). Re-run audit:legacy-streams to confirm.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "repair failed");
    process.exitCode = 1;
  });
}
