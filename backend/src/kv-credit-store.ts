import { calculateCreditWithBonus, monthKey, monthlyStreamMicroUsd } from "./credit-bonus.js";
import { CreditReservation, GdCreditEntry, StreamState, UserCreditProfile } from "./types.js";

type KV = Pick<KVNamespace, "get" | "put">;

const USER_PREFIX = "user:";
const REQUEST_PREFIX = "request:";
const USER_REQUESTS_PREFIX = "user-requests:";
const GD_CREDIT_PREFIX = "gd-credit:";
const USER_GD_CREDITS_PREFIX = "user-gd-credits:";
const STREAM_PREFIX = "stream:";
const STREAM_INDEX_KEY = "stream-index";
const STREAM_BONUS_USED_PREFIX = "stream-bonus-used:";
const STREAM_MONTH_SECONDS = BigInt(30 * 24 * 60 * 60);
const STREAM_BONUS_BPS = 2_000n;
const BPS = 10_000n;
const MAX_TRACKED_STREAMS = 1000;

export class KVCreditStore {
  constructor(private readonly kv: KV) { }


  async recordGdCredit(input: {
    id: string;
    account: string;
    rootAccount?: string;
    isVerified: boolean;
    source: GdCreditEntry["source"];
    gdAmountWei: bigint;
    txHash?: string;
    logIndex?: number;
    date?: Date;
    gdPrice: bigint;
    flowRate?: bigint;
  }): Promise<GdCreditEntry> {
    const account = normalizeAccount(input.account);
    const rootAccount = normalizeAccount(input.rootAccount ?? input.account);
    const entryId = input.id;
    const existing = await this.getJson<GdCreditEntry>(`${GD_CREDIT_PREFIX}${entryId}`);
    if (existing) return existing;
    const month = monthKey(input.date ?? new Date());
    const profile = await this.getUser(rootAccount);
    const bonus = calculateCreditWithBonus(input.gdAmountWei, input.source, input.isVerified, input.gdPrice);

    const now = new Date().toISOString();
    const entry: GdCreditEntry = {
      id: entryId,
      account,
      rootAccount,
      source: input.source,
      gdAmountWei: input.gdAmountWei.toString(),
      principalMicroUsd: bonus.principalMicroUsd.toString(),
      bonusMicroUsd: bonus.bonusMicroUsd.toString(),
      totalCreditMicroUsd: bonus.totalCreditMicroUsd.toString(),
      streamUpdateMonth: month,
      txHash: input.txHash,
      logIndex: input.logIndex,
      fundingStatus: "pending",
      createdAt: now
    };

    await this.putJson(`${GD_CREDIT_PREFIX}${entry.id}`, entry);
    await this.updateUser(account, rootAccount, (current) => ({
      ...current,
      rootAccount: rootAccount,
      createdAt: current.createdAt ?? now,
      updatedAt: now,
      streamFlowRateWeiPerSecond: input.flowRate ? input.flowRate.toString() : current.streamFlowRateWeiPerSecond,
      totalGdDepositedWei: addDecimalStrings(current.totalGdDepositedWei, entry.gdAmountWei),
      totalGDStreamedWei: input.source.startsWith("stream") ? addDecimalStrings(current.totalGDStreamedWei, entry.gdAmountWei) : current.totalGDStreamedWei,
    }));

    return entry;
  }

  async markFundingResult(entry: GdCreditEntry, result: { funded: boolean; id?: string; txHash?: string; error?: string }): Promise<GdCreditEntry> {
    if (entry.fundingStatus === "funded" || entry.fundingStatus === "failed") return entry;

    entry.fundingStatus = result.funded ? "funded" : "failed";
    entry.fundingTxHash = result.txHash;
    entry.fundingError = result.error;
    await this.putJson(`${GD_CREDIT_PREFIX}${entry.id}`, entry);

    if (result.funded) {
      const now = new Date().toISOString();
      await this.updateUser(entry.account, entry.rootAccount, (current) => ({
        ...current,
        updatedAt: now,
        // update these values post actual usdc deposit to correctly reflect credited amount in user profile
        lastStreamCreditAt: entry.source.startsWith("stream") ? now : current.lastStreamCreditAt, // Update last time we credited this account for its stream. required for correctly crediting user on streams by request our in our monthly cron
        totalPrincipalMicroUsd: (BigInt(current.totalPrincipalMicroUsd) + BigInt(entry.principalMicroUsd)).toString(),
        totalBonusMicroUsd: (BigInt(current.totalBonusMicroUsd) + BigInt(entry.bonusMicroUsd)).toString(),
      }));
    }
    return entry;
  }

  async getWithdrawablePrincipal(account: string): Promise<bigint> {
    const normalized = normalizeAccount(account);
    const profile = await this.getUser(normalized);
    const principal = BigInt(profile.totalPrincipalMicroUsd);
    const withdrawn = BigInt(profile.totalWithdrawnPrincipalMicroUsd);
    const maxWithdrawable = principal > withdrawn ? principal - withdrawn : 0n;
    return maxWithdrawable;
  }

  async withdrawPrincipal(account: string, rootAccount: string, amountMicroUsd: bigint): Promise<void> {
    const normalized = normalizeAccount(account);

    const maxWithdrawable = await this.getWithdrawablePrincipal(account);
    if (amountMicroUsd <= 0n) throw new Error("amount must be positive");

    if (amountMicroUsd > maxWithdrawable) {
      throw new Error(`insufficient deposited principal (max withdrawable: ${maxWithdrawable})`);
    }

    const now = new Date().toISOString();
    return this.updateUser(account, rootAccount, (current) => ({ ...current, updatedAt: now, totalWithdrawnPrincipalMicroUsd: addDecimalStrings(current.totalWithdrawnPrincipalMicroUsd, amountMicroUsd.toString()) }));
  }

  async getGdCredits(account: string): Promise<GdCreditEntry[]> {
    const normalized = normalizeAccount(account);
    const ids = (await this.getJson<string[]>(`${USER_GD_CREDITS_PREFIX}${normalized}`)) ?? [];
    const entries = await Promise.all(ids.map((id) => this.getJson<GdCreditEntry>(`${GD_CREDIT_PREFIX}${id}`)));
    return entries.filter((item): item is GdCreditEntry => Boolean(item));
  }


  async getUser(account: string): Promise<UserCreditProfile> {
    const normalized = normalizeAccount(account);
    const saved = await this.getJson<Partial<UserCreditProfile>>(`${USER_PREFIX}${normalized}`);
    return normalizeProfile(saved, normalized);
  }

  private async addGdCreditToAccount(account: string, entryId: string): Promise<void> {
    const key = `${USER_GD_CREDITS_PREFIX}${account}`;
    const ids = (await this.getJson<string[]>(key)) ?? [];
    if (!ids.includes(entryId)) ids.push(entryId);
    await this.putJson(key, ids.slice(-500));
  }



  private async updateUser(account: string, rootAccount: string | undefined, mutate: (profile: UserCreditProfile) => UserCreditProfile): Promise<void> {
    const normalized = normalizeAccount(account);
    const normalizedRoot = normalizeAccount(rootAccount ?? account);
    const current = await this.getUser(normalized);
    const next = mutate({ ...current, rootAccount: normalizedRoot });
    await this.putJson(`${USER_PREFIX}${normalized}`, next);

    if (normalizedRoot !== normalized) {
      const rootCurrent = await this.getUser(normalizedRoot);
      const rootNext = mutate({ ...rootCurrent, account: normalizedRoot, rootAccount: normalizedRoot });
      await this.putJson(`${USER_PREFIX}${normalizedRoot}`, rootNext);
    }
  }

  private async getJson<T>(key: string): Promise<T | undefined> {
    const value = await this.kv.get(key, "json");
    return (value ?? undefined) as T | undefined;
  }

  private async putJson(key: string, value: unknown): Promise<void> {
    await this.kv.put(key, JSON.stringify(value));
  }
}

function normalizeProfile(saved: Partial<UserCreditProfile> | undefined, account: string): UserCreditProfile {
  const createdAt = saved?.createdAt ?? new Date().toISOString();
  return {
    account,
    rootAccount: saved?.rootAccount ?? account,
    createdAt,
    updatedAt: saved?.updatedAt ?? createdAt,
    totalGdDepositedWei: saved?.totalGdDepositedWei ?? "0",
    totalBonusMicroUsd: saved?.totalBonusMicroUsd ?? "0",
    totalWithdrawnPrincipalMicroUsd: saved?.totalWithdrawnPrincipalMicroUsd ?? "0",
    streamFlowRateWeiPerSecond: saved?.streamFlowRateWeiPerSecond ?? "0",
    totalPrincipalMicroUsd: saved?.totalPrincipalMicroUsd ?? "0",
    totalGDStreamedWei: saved?.totalGDStreamedWei ?? "0",
    lastStreamCreditAt: saved?.lastStreamCreditAt ?? createdAt,
  };
}

function normalizeAccount(account: string): string {
  return account.toLowerCase();
}

function addDecimalStrings(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

