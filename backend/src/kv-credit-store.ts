import { calculateCreditWithBonus, monthKey } from "./credit-bonus.js";
import { GdCreditEntry, UserCreditProfile } from "./types.js";

type KV = Pick<KVNamespace, "get" | "put">;

const USER_PREFIX = "user:";
const GD_CREDIT_PREFIX = "gd-credit:";
const USER_GD_CREDITS_PREFIX = "user-gd-credits:";
const MONTHLY_BONUS_PREFIX = "monthly-bonus:";

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
    maxBonusCapMicroUsd: bigint;
    buyerAddress?: string;
  }): Promise<GdCreditEntry> {
    const account = normalizeAccount(input.account);
    const rootAccount = normalizeAccount(input.rootAccount ?? input.account);
    const entryId = input.id;
    const existing = await this.getJson<GdCreditEntry>(`${GD_CREDIT_PREFIX}${entryId}`);
    if (existing) return existing;
    const month = monthKey(input.date ?? new Date());
    const bonus = calculateCreditWithBonus(input.gdAmountWei, input.source, input.isVerified, input.gdPrice);

    // Enforce per-root-account monthly bonus cap
    let effectiveBonusMicroUsd = bonus.bonusMicroUsd;
    if (effectiveBonusMicroUsd > 0n && input.maxBonusCapMicroUsd > 0n) {
      const monthlyBonusUsed = await this.getMonthlyBonusUsed(rootAccount, month);
      const remainingCap = input.maxBonusCapMicroUsd > monthlyBonusUsed
        ? input.maxBonusCapMicroUsd - monthlyBonusUsed
        : 0n;
      if (effectiveBonusMicroUsd > remainingCap) {
        effectiveBonusMicroUsd = remainingCap;
      }
    }

    const now = new Date().toISOString();
    const entry: GdCreditEntry = {
      id: entryId,
      account,
      rootAccount,
      source: input.source,
      gdAmountWei: input.gdAmountWei.toString(),
      principalMicroUsd: bonus.principalMicroUsd.toString(),
      bonusMicroUsd: effectiveBonusMicroUsd.toString(),
      totalCreditMicroUsd: (bonus.principalMicroUsd + effectiveBonusMicroUsd).toString(),
      streamUpdateMonth: month,
      txHash: input.txHash,
      logIndex: input.logIndex,
      fundingStatus: "pending",
      createdAt: now,
      buyerAddress: input.buyerAddress ? input.buyerAddress.toLowerCase() : undefined
    };

    await this.putJson(`${GD_CREDIT_PREFIX}${entry.id}`, entry);
    await this.addGdCreditToAccount(account, entry.id);
    if (rootAccount && rootAccount !== account) {
      await this.addGdCreditToAccount(rootAccount, entry.id);
    }
    if (effectiveBonusMicroUsd > 0n) {
      await this.addMonthlyBonusUsed(rootAccount, month, effectiveBonusMicroUsd);
    }
    const effectiveBuyer = (entry.buyerAddress ?? account).toLowerCase();
    await this.updateUser(account, rootAccount, (current) => {
      assertBuyerMatches(current, effectiveBuyer);
      return {
        ...current,
        rootAccount: rootAccount,
        createdAt: current.createdAt ?? now,
        updatedAt: now,
        streamFlowRateWeiPerSecond: input.flowRate ? input.flowRate.toString() : current.streamFlowRateWeiPerSecond,
        totalGdDepositedWei: addDecimalStrings(current.totalGdDepositedWei, entry.gdAmountWei),
        totalGDStreamedWei: input.source.startsWith("stream") ? addDecimalStrings(current.totalGDStreamedWei, entry.gdAmountWei) : current.totalGDStreamedWei,
        totalOutstandingFundingMicroUsd: addDecimalStrings(current.totalOutstandingFundingMicroUsd, entry.totalCreditMicroUsd),
      };
    });

    return (await this.getJson<GdCreditEntry>(`${GD_CREDIT_PREFIX}${entryId}`))!;
  }

  async markFundingResult(entry: GdCreditEntry, result: { funded: boolean; id?: string; txHash?: string; error?: string }): Promise<GdCreditEntry> {
    if (entry.fundingStatus === "funded" || entry.fundingStatus === "failed") return entry;

    entry.fundingStatus = result.funded ? "funded" : "failed";
    entry.fundingTxHash = result.txHash;
    entry.fundingError = result.error;
    await this.putJson(`${GD_CREDIT_PREFIX}${entry.id}`, entry);

    if (result.funded) {
      const now = new Date().toISOString();
      await this.updateUser(entry.account, entry.rootAccount, (current) => {
        const outstanding = BigInt(current.totalOutstandingFundingMicroUsd);
        const creditAmount = BigInt(entry.totalCreditMicroUsd);
        return {
          ...current,
          updatedAt: now,
          lastStreamCreditAt: entry.source.startsWith("stream") ? now : current.lastStreamCreditAt,
          totalPrincipalMicroUsd: (BigInt(current.totalPrincipalMicroUsd) + BigInt(entry.principalMicroUsd)).toString(),
          totalBonusMicroUsd: (BigInt(current.totalBonusMicroUsd) + BigInt(entry.bonusMicroUsd)).toString(),
          totalOutstandingFundingMicroUsd: (outstanding > creditAmount ? outstanding - creditAmount : 0n).toString(),
        };
      });
    }
    return entry;
  }

  async getGdCredits(account: string): Promise<GdCreditEntry[]> {
    const normalized = normalizeAccount(account);
    const ids = (await this.getJson<string[]>(`${USER_GD_CREDITS_PREFIX}${normalized}`)) ?? [];
    const entries = await Promise.all(ids.map((id) => this.getJson<GdCreditEntry>(`${GD_CREDIT_PREFIX}${id}`)));
    return entries.filter((item): item is GdCreditEntry => Boolean(item));
  }

  async listGdCredits(
    account: string,
    options: { status?: GdCreditEntry["fundingStatus"]; limit?: number; cursor?: string } = {}
  ): Promise<{ transactions: GdCreditEntry[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    let entries = await this.getGdCredits(account);
    if (options.status) {
      entries = entries.filter((entry) => entry.fundingStatus === options.status);
    }
    entries.sort((a, b) => {
      const byCreatedAt = b.createdAt.localeCompare(a.createdAt);
      return byCreatedAt !== 0 ? byCreatedAt : b.id.localeCompare(a.id);
    });
    if (options.cursor) {
      const cursorIndex = entries.findIndex((entry) => entry.id === options.cursor);
      if (cursorIndex >= 0) {
        entries = entries.slice(cursorIndex + 1);
      }
    }
    const page = entries.slice(0, limit);
    const nextCursor = entries.length > limit ? page[page.length - 1]?.id : undefined;
    return { transactions: page, nextCursor };
  }

  async getUser(account: string): Promise<UserCreditProfile> {
    const normalized = normalizeAccount(account);
    const saved = await this.getJson<Partial<UserCreditProfile>>(`${USER_PREFIX}${normalized}`);
    return normalizeProfile(saved, normalized);
  }

  async setBuyer(account: string, buyerAddress: string, rootAccount?: string): Promise<UserCreditProfile> {
    const normalized = normalizeAccount(account);
    const buyer = normalizeAccount(buyerAddress);
    const root = normalizeAccount(rootAccount ?? account);
    const now = new Date().toISOString();
    await this.updateUser(normalized, root, (current) => ({
      ...assignBuyer(current, buyer),
      updatedAt: now,
    }));
    return this.getUser(normalized);
  }

  private async addGdCreditToAccount(account: string, entryId: string): Promise<void> {
    const key = `${USER_GD_CREDITS_PREFIX}${account}`;
    const ids = (await this.getJson<string[]>(key)) ?? [];
    if (!ids.includes(entryId)) ids.push(entryId);
    await this.putJson(key, ids.slice(-500));
  }

  private async getMonthlyBonusUsed(rootAccount: string, month: string): Promise<bigint> {
    const key = `${MONTHLY_BONUS_PREFIX}${rootAccount}:${month}`;
    const value = await this.getJson<string>(key);
    return value ? BigInt(value) : 0n;
  }

  private async addMonthlyBonusUsed(rootAccount: string, month: string, amount: bigint): Promise<void> {
    const key = `${MONTHLY_BONUS_PREFIX}${rootAccount}:${month}`;
    const current = await this.getMonthlyBonusUsed(rootAccount, month);
    await this.putJson(key, (current + amount).toString());
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
      rootNext.buyer = rootCurrent.buyer;
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
    streamFlowRateWeiPerSecond: saved?.streamFlowRateWeiPerSecond ?? "0",
    totalPrincipalMicroUsd: saved?.totalPrincipalMicroUsd ?? "0",
    totalGDStreamedWei: saved?.totalGDStreamedWei ?? "0",
    totalOutstandingFundingMicroUsd: saved?.totalOutstandingFundingMicroUsd ?? "0",
    lastStreamCreditAt: saved?.lastStreamCreditAt ?? createdAt,
    buyer: normalizeBuyer(saved?.buyer),
  };
}

function normalizeBuyer(buyer: string | undefined): string | undefined {
  return buyer ? buyer.toLowerCase() : undefined;
}

function assignBuyer(profile: UserCreditProfile, buyer: string): UserCreditProfile {
  const normalized = buyer.toLowerCase();
  if (!profile.buyer) return { ...profile, buyer: normalized };
  if (profile.buyer === normalized) return profile;
  throw new Error(`payer ${profile.account} is linked to buyer ${profile.buyer}, cannot use ${normalized}`);
}

function assertBuyerMatches(profile: UserCreditProfile, buyer: string): void {
  const normalized = buyer.toLowerCase();
  if (profile.buyer && profile.buyer !== normalized) {
    throw new Error(`payer ${profile.account} is linked to buyer ${profile.buyer}, cannot credit buyer ${normalized}`);
  }
}

function normalizeAccount(account: string): string {
  return account.toLowerCase();
}

function addDecimalStrings(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

