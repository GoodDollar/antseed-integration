import { calculateCreditWithBonus, monthKey } from "./credit-bonus.js";
import { GdCreditEntry, UserCreditProfile } from "./types.js";
import { logInfo, logWarn, redactAddress } from "./logging.js";

type KV = Pick<KVNamespace, "get" | "put">;

const USER_PREFIX = "user:";
const GD_CREDIT_PREFIX = "gd-credit:";
const USER_GD_CREDITS_PREFIX = "user-gd-credits:";
const MONTHLY_BONUS_PREFIX = "monthly-bonus:";

export class KVCreditStore {
  constructor(private readonly kv: KV) {}

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
    gdPrice: number;
    flowRate?: bigint;
    maxBonusCapUsd: bigint;
    buyerAddress?: string;
  }): Promise<GdCreditEntry> {
    const account = normalizeAccount(input.account);
    const rootAccount = normalizeAccount(input.rootAccount ?? input.account);
    const entryId = input.id;
    const existing = await this.getJson<GdCreditEntry>(`${GD_CREDIT_PREFIX}${entryId}`);
    if (existing) {
      logWarn("kv.credit.idempotent-hit", {
        entryId,
        account: redactAddress(account),
        source: input.source,
        existingStatus: existing.fundingStatus,
      });
      return existing;
    }
    const month = monthKey(input.date ?? new Date());
    const bonus = calculateCreditWithBonus(input.gdAmountWei, input.source, input.isVerified, input.gdPrice);

    // Enforce per-root-account monthly bonus cap
    let effectiveBonusUsd = bonus.bonusUsd;
    if (effectiveBonusUsd > 0n && input.maxBonusCapUsd > 0n) {
      const monthlyBonusUsed = await this.getMonthlyBonusUsed(rootAccount, month);
      const remainingCap = input.maxBonusCapUsd > monthlyBonusUsed ? input.maxBonusCapUsd - monthlyBonusUsed : 0n;
      if (effectiveBonusUsd > remainingCap) {
        logInfo("kv.credit.bonus-capped", {
          entryId,
          rootAccount: redactAddress(rootAccount),
          requestedBonusUsd: effectiveBonusUsd.toString(),
          remainingCapUsd: remainingCap.toString(),
        });
        effectiveBonusUsd = remainingCap;
      }
    }

    const now = new Date().toISOString();
    const entry: GdCreditEntry = {
      id: entryId,
      account,
      rootAccount,
      source: input.source,
      gdAmountWei: input.gdAmountWei.toString(),
      principalUsd: bonus.principalUsd.toString(),
      bonusUsd: effectiveBonusUsd.toString(),
      totalCreditUsd: (bonus.principalUsd + effectiveBonusUsd).toString(),
      streamUpdateMonth: month,
      ...(input.txHash !== undefined && { txHash: input.txHash }),
      ...(input.logIndex !== undefined && { logIndex: input.logIndex }),
      fundingStatus: "pending",
      createdAt: now,
      ...(input.buyerAddress && {
        buyerAddress: input.buyerAddress.toLowerCase(),
      }),
    };

    await this.putJson(`${GD_CREDIT_PREFIX}${entry.id}`, entry);
    await this.addGdCreditToAccount(account, entry.id);
    if (rootAccount && rootAccount !== account) {
      await this.addGdCreditToAccount(rootAccount, entry.id);
    }
    if (effectiveBonusUsd > 0n) {
      await this.addMonthlyBonusUsed(rootAccount, month, effectiveBonusUsd);
    }
    await this.updateUser(account, rootAccount, (current) => ({
      ...current,
      rootAccount: rootAccount,
      createdAt: current.createdAt ?? now,
      updatedAt: now,
      streamFlowRateWeiPerSecond: input.flowRate ? input.flowRate.toString() : current.streamFlowRateWeiPerSecond,
      totalGdDepositedWei: addDecimalStrings(current.totalGdDepositedWei, entry.gdAmountWei),
      totalGDStreamedWei: input.source.startsWith("stream") ? addDecimalStrings(current.totalGDStreamedWei, entry.gdAmountWei) : current.totalGDStreamedWei,
      totalOutstandingFundingUsd: addDecimalStrings(current.totalOutstandingFundingUsd, entry.totalCreditUsd),
    }));

    logInfo("kv.credit.recorded", {
      entryId: entry.id,
      account: redactAddress(entry.account),
      rootAccount: redactAddress(entry.rootAccount),
      source: entry.source,
      principalUsd: entry.principalUsd,
      bonusUsd: entry.bonusUsd,
      totalCreditUsd: entry.totalCreditUsd,
      buyer: entry.buyerAddress,
      input,
    });

    return entry;
  }

  async markFundingResult(entry: GdCreditEntry, result: { funded: boolean; id?: string; txHash?: string; error?: string }): Promise<GdCreditEntry> {
    if (entry.fundingStatus === "funded" || entry.fundingStatus === "failed") {
      logWarn("kv.funding.already-terminal", {
        entryId: entry.id,
        account: redactAddress(entry.account),
        fundingStatus: entry.fundingStatus,
      });
      return entry;
    }

    entry.fundingStatus = result.funded ? "funded" : "failed";
    entry.fundingTxHash = result.txHash;
    entry.fundingError = result.error;
    await this.putJson(`${GD_CREDIT_PREFIX}${entry.id}`, entry);

    if (result.funded) {
      const now = new Date().toISOString();
      await this.updateUser(entry.account, entry.rootAccount, (current) => {
        const outstanding = BigInt(current.totalOutstandingFundingUsd);
        const creditAmount = BigInt(entry.totalCreditUsd);
        return {
          ...current,
          updatedAt: now,
          lastStreamCreditAt: entry.source.startsWith("stream") ? now : current.lastStreamCreditAt,
          totalPrincipalUsd: (BigInt(current.totalPrincipalUsd) + BigInt(entry.principalUsd)).toString(),
          totalBonusUsd: (BigInt(current.totalBonusUsd) + BigInt(entry.bonusUsd)).toString(),
          totalOutstandingFundingUsd: (outstanding > creditAmount ? outstanding - creditAmount : 0n).toString(),
        };
      });
    }
    logInfo("kv.funding.result", {
      entryId: entry.id,
      account: redactAddress(entry.account),
      source: entry.source,
      fundingStatus: entry.fundingStatus,
      txHash: result.txHash,
      error: result.error,
    });
    return entry;
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
      const rootNext = mutate({
        ...rootCurrent,
        account: normalizedRoot,
        rootAccount: normalizedRoot,
      });
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
    totalBonusUsd: saved?.totalBonusUsd ?? "0",
    streamFlowRateWeiPerSecond: saved?.streamFlowRateWeiPerSecond ?? "0",
    totalPrincipalUsd: saved?.totalPrincipalUsd ?? "0",
    totalGDStreamedWei: saved?.totalGDStreamedWei ?? "0",
    totalOutstandingFundingUsd: saved?.totalOutstandingFundingUsd ?? "0",
    lastStreamCreditAt: saved?.lastStreamCreditAt,
  };
}

function normalizeAccount(account: string): string {
  return account.toLowerCase();
}

function addDecimalStrings(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}
