/**
 * Recompute a user profile's lifetime totals from its credit entries.
 *
 * Before the stream-credit accounting fix, `recordGdCredit` added `gdAmountWei` to
 * `totalGdDepositedWei` / `totalGDStreamedWei` at record time, so an entry whose on-chain funding
 * reverted still inflated those counters -- and `totalOutstandingFundingUsd` was never released for
 * a failed entry. Profiles touched by that are permanently wrong (one account carries 6.23M G$
 * "deposited" against a $4.25 balance, from a single reverted 6.19M G$ entry).
 *
 * This rebuilds all five counters from the funded entries, which is now the source of truth.
 *
 * Usage:
 *   DRY_RUN=1 tsx scripts/repair-credit-totals.ts 0x2CeADe...0627 [0xmore...]
 *   tsx scripts/repair-credit-totals.ts 0x2CeADe...0627
 *
 * Reads and writes production KV through `wrangler kv key --remote`, so it needs the same wrangler
 * auth as `yarn deploy`. Always inspect the DRY_RUN diff first.
 */
import { execFileSync } from "node:child_process";
import { GdCreditEntry, UserCreditProfile } from "../src/types.js";

const BINDING = "ANTSEED_KV";
const USER_PREFIX = "user:";
const GD_CREDIT_PREFIX = "gd-credit:";
const USER_GD_CREDITS_PREFIX = "user-gd-credits:";

const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

const main = async () => {
  const accounts = process.argv.slice(2).map((value) => value.toLowerCase());
  if (accounts.length === 0) {
    throw new Error("usage: tsx scripts/repair-credit-totals.ts <account> [account...]");
  }
  if (dryRun) console.log("DRY_RUN: no writes will be made\n");

  for (const account of accounts) {
    const profile = kvGet<UserCreditProfile>(`${USER_PREFIX}${account}`);
    if (!profile) {
      console.log(`${account}: no profile, skipping`);
      continue;
    }

    const entryIds = kvGet<string[]>(`${USER_GD_CREDITS_PREFIX}${account}`) ?? [];
    const entries = entryIds.map((id) => kvGet<GdCreditEntry>(`${GD_CREDIT_PREFIX}${id}`)).filter((entry): entry is GdCreditEntry => Boolean(entry));

    const repaired = recomputeTotals(profile, entries);
    report(account, entries, profile, repaired);

    if (dryRun) continue;
    kvPut(`${USER_PREFIX}${account}`, repaired);
    console.log(`  written\n`);
  }
};

/**
 * Lifetime totals are the sum over funded entries; anything pending or failed contributes nothing.
 * Pending entries remain outstanding, since their funding has not resolved yet.
 */
function recomputeTotals(profile: UserCreditProfile, entries: GdCreditEntry[]): UserCreditProfile {
  let depositedWei = 0n;
  let streamedWei = 0n;
  let principalUsd = 0n;
  let bonusUsd = 0n;
  let outstandingUsd = 0n;

  for (const entry of entries) {
    if (entry.fundingStatus === "funded") {
      depositedWei += BigInt(entry.gdAmountWei);
      if (entry.source.startsWith("stream")) streamedWei += BigInt(entry.gdAmountWei);
      principalUsd += BigInt(entry.principalUsd);
      bonusUsd += BigInt(entry.bonusUsd);
    } else if (entry.fundingStatus === "pending") {
      outstandingUsd += BigInt(entry.totalCreditUsd);
    }
  }

  return {
    ...profile,
    updatedAt: new Date().toISOString(),
    totalGdDepositedWei: depositedWei.toString(),
    totalGDStreamedWei: streamedWei.toString(),
    totalPrincipalUsd: principalUsd.toString(),
    totalBonusUsd: bonusUsd.toString(),
    totalOutstandingFundingUsd: outstandingUsd.toString()
  };
}

function report(account: string, entries: GdCreditEntry[], before: UserCreditProfile, after: UserCreditProfile): void {
  const byStatus = entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.fundingStatus] = (acc[entry.fundingStatus] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`${account}: ${entries.length} entries (${JSON.stringify(byStatus)})`);
  for (const field of ["totalGdDepositedWei", "totalGDStreamedWei", "totalPrincipalUsd", "totalBonusUsd", "totalOutstandingFundingUsd"] as const) {
    const changed = before[field] !== after[field];
    console.log(`  ${changed ? "~" : " "} ${field}: ${before[field]} -> ${after[field]}`);
  }
}

function kvGet<T>(key: string): T | undefined {
  try {
    const raw = execFileSync("npx", ["wrangler", "kv", "key", "get", key, "--binding", BINDING, "--remote"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function kvPut(key: string, value: unknown): void {
  execFileSync("npx", ["wrangler", "kv", "key", "put", key, JSON.stringify(value), "--binding", BINDING, "--remote"], {
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"]
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
