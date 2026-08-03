import { calculateCreditWithBonus, monthKey } from "./credit-bonus.js";
import { GdCreditEntry, PayerBuyer, UserCreditProfile } from "./types.js";
import { logInfo, logWarn, redactAddress } from "./logging.js";

type KV = Pick<KVNamespace, "get" | "put">;

const USER_PREFIX = "user:";
const USER_BUYERS_PREFIX = "user-buyers:";
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
    regularBonusBps?: bigint;
    streamingBonusBps?: bigint;
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
        existingStatus: existing.fundingStatus
      });
      return existing;
    }
    const month = monthKey(input.date ?? new Date());
    const bonus = calculateCreditWithBonus(input.gdAmountWei, input.source, input.isVerified, input.gdPrice, input.regularBonusBps, input.streamingBonusBps);

    let effectiveBonusUsd = bonus.bonusUsd;
    if (effectiveBonusUsd > 0n && input.maxBonusCapUsd > 0n) {
      const monthlyBonusUsed = await this.getMonthlyBonusUsed(rootAccount, month);
      const remainingCap = input.maxBonusCapUsd > monthlyBonusUsed ? input.maxBonusCapUsd - monthlyBonusUsed : 0n;
      if (effectiveBonusUsd > remainingCap) {
        logInfo("kv.credit.bonus-capped", {
          entryId,
          rootAccount: redactAddress(rootAccount),
          requestedBonusUsd: effectiveBonusUsd.toString(),
          remainingCapUsd: remainingCap.toString()
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
        buyerAddress: input.buyerAddress.toLowerCase()
      })
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
      totalOutstandingFundingUsd: addDecimalStrings(current.totalOutstandingFundingUsd, entry.totalCreditUsd)
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
      input
    });

    return entry;
  }

  async markFundingResult(entry: GdCreditEntry, result: { funded: boolean; id?: string; txHash?: string; error?: string }): Promise<GdCreditEntry> {
    if (entry.fundingStatus === "funded" || entry.fundingStatus === "failed") {
      logWarn("kv.funding.already-terminal", {
        entryId: entry.id,
        account: redactAddress(entry.account),
        fundingStatus: entry.fundingStatus
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
          totalOutstandingFundingUsd: (outstanding > creditAmount ? outstanding - creditAmount : 0n).toString()
        };
      });
    }
    logInfo("kv.funding.result", {
      entryId: entry.id,
      account: redactAddress(entry.account),
      source: entry.source,
      fundingStatus: entry.fundingStatus,
      txHash: result.txHash,
      error: result.error
    });
    return entry;
  }

  async getGdCredits(account: string): Promise<GdCreditEntry[]> {
    const normalized = normalizeAccount(account);
    const ids = (await this.getJson<string[]>(`${USER_GD_CREDITS_PREFIX}${normalized}`)) ?? [];
    const entries = await Promise.all(ids.map((id) => this.getJson<GdCreditEntry>(`${GD_CREDIT_PREFIX}${id}`)));
    return entries.filter((item): item is GdCreditEntry => Boolean(item));
  }

  async getGdCreditHistory(
    account: string,
    options: {
      limit: number;
      offset: number;
      source?: GdCreditEntry["source"];
      fundingStatus?: GdCreditEntry["fundingStatus"];
      from?: string;
      to?: string;
    }
  ): Promise<{ items: GdCreditEntry[]; total: number; limit: number; offset: number; hasMore: boolean }> {
    let entries = await this.getGdCredits(account);
    entries = [...entries].sort((a, b) => {
      const byCreated = b.createdAt.localeCompare(a.createdAt);
      if (byCreated !== 0) return byCreated;
      return b.id.localeCompare(a.id);
    });
    if (options.source) {
      entries = entries.filter((entry) => entry.source === options.source);
    }
    if (options.fundingStatus) {
      entries = entries.filter((entry) => entry.fundingStatus === options.fundingStatus);
    }
    if (options.from) {
      const fromMs = Date.parse(options.from);
      entries = entries.filter((entry) => Date.parse(entry.createdAt) >= fromMs);
    }
    if (options.to) {
      const toMs = Date.parse(options.to);
      entries = entries.filter((entry) => Date.parse(entry.createdAt) <= toMs);
    }
    const total = entries.length;
    const items = entries.slice(options.offset, options.offset + options.limit);
    return {
      items,
      total,
      limit: options.limit,
      offset: options.offset,
      hasMore: options.offset + options.limit < total
    };
  }

  async getUser(account: string): Promise<UserCreditProfile> {
    const profile = await this.getUserRecord(account);
    return {
      ...profile,
      buyers: await this.getBuyers(profile.account)
    };
  }

  async getBuyers(payer: string): Promise<PayerBuyer[]> {
    const normalizedPayer = normalizeAccount(payer);
    const saved = await this.getJson<PayerBuyer[]>(`${USER_BUYERS_PREFIX}${normalizedPayer}`);
    if (Array.isArray(saved)) {
      return normalizeBuyers(saved);
    }

    const legacy = await this.getJson<Partial<UserCreditProfile>>(`${USER_PREFIX}${normalizedPayer}`);
    const legacyBuyers = normalizeBuyers(legacy?.buyers);
    if (legacyBuyers.length === 0) {
      return [];
    }

    await this.putJson(`${USER_BUYERS_PREFIX}${normalizedPayer}`, legacyBuyers);
    if (legacy) {
      await this.putJson(`${USER_PREFIX}${normalizedPayer}`, profileForStorage(normalizeProfile(legacy, normalizedPayer)));
    }
    logInfo("kv.payer.buyers-migrated", {
      payer: redactAddress(normalizedPayer),
      buyerCount: legacyBuyers.length
    });
    return legacyBuyers;
  }

  async addBuyerToPayer(payer: string, buyer: string, consentedAt?: string): Promise<UserCreditProfile> {
    const normalizedPayer = normalizeAccount(payer);
    const normalizedBuyer = normalizeAccount(buyer);
    const buyers = await this.getBuyers(normalizedPayer);
    const existing = buyers.find((item) => item.address === normalizedBuyer);
    if (existing) {
      const profile = await this.getUserRecord(normalizedPayer);
      return { ...profile, buyers };
    }
    const now = consentedAt ?? new Date().toISOString();
    const nextBuyers = [...buyers, { address: normalizedBuyer, consentedAt: now }];
    await this.putJson(`${USER_BUYERS_PREFIX}${normalizedPayer}`, nextBuyers);
    logInfo("kv.payer.buyer-added", {
      payer: redactAddress(normalizedPayer),
      buyer: redactAddress(normalizedBuyer),
      buyerCount: nextBuyers.length
    });
    const profile = await this.getUserRecord(normalizedPayer);
    return { ...profile, buyers: nextBuyers };
  }

  async backfillBuyersFromCredits(payer: string): Promise<{
    profile: UserCreditProfile;
    added: PayerBuyer[];
    skipped: string[];
  }> {
    const normalizedPayer = normalizeAccount(payer);
    const currentBuyers = await this.getBuyers(normalizedPayer);
    const known = new Set(currentBuyers.map((item) => item.address));
    const earliestByBuyer = new Map<string, string>();
    const credits = await this.getGdCredits(normalizedPayer);
    for (const entry of credits) {
      const buyer = entry.buyerAddress ? normalizeAccount(entry.buyerAddress) : undefined;
      if (!buyer) continue;
      const prev = earliestByBuyer.get(buyer);
      if (!prev || entry.createdAt < prev) {
        earliestByBuyer.set(buyer, entry.createdAt);
      }
    }

    const added: PayerBuyer[] = [];
    const skipped: string[] = [];
    let buyers = [...currentBuyers];
    for (const [buyer, consentedAt] of earliestByBuyer) {
      if (known.has(buyer)) {
        skipped.push(buyer);
        continue;
      }
      const record: PayerBuyer = { address: buyer, consentedAt };
      buyers = [...buyers, record];
      known.add(buyer);
      added.push(record);
    }

    const profile = await this.getUserRecord(normalizedPayer);
    if (added.length === 0) {
      return { profile: { ...profile, buyers }, added, skipped };
    }

    await this.putJson(`${USER_BUYERS_PREFIX}${normalizedPayer}`, buyers);
    logInfo("kv.payer.buyers-backfilled", {
      payer: redactAddress(normalizedPayer),
      added: added.length,
      skipped: skipped.length,
      buyerCount: buyers.length
    });
    return { profile: { ...profile, buyers }, added, skipped };
  }

  private async getUserRecord(account: string): Promise<UserCreditProfile> {
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
    const current = await this.getUserRecord(normalized);
    const next = mutate({ ...current, rootAccount: normalizedRoot });
    await this.putJson(`${USER_PREFIX}${normalized}`, profileForStorage(next));

    if (normalizedRoot !== normalized) {
      const rootCurrent = await this.getUserRecord(normalizedRoot);
      const rootNext = mutate({
        ...rootCurrent,
        account: normalizedRoot,
        rootAccount: normalizedRoot
      });
      await this.putJson(`${USER_PREFIX}${normalizedRoot}`, profileForStorage(rootNext));
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

function normalizeBuyers(saved: Partial<PayerBuyer>[] | undefined): PayerBuyer[] {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((item): item is PayerBuyer => Boolean(item?.address) && Boolean(item?.consentedAt))
    .map((item) => ({
      address: normalizeAccount(item.address),
      consentedAt: item.consentedAt
    }));
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
    buyers: []
  };
}

function profileForStorage(profile: UserCreditProfile): Omit<UserCreditProfile, "buyers"> {
  const { buyers: _buyers, ...rest } = profile;
  return rest;
}

function normalizeAccount(account: string): string {
  return account.toLowerCase();
}

function addDecimalStrings(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}
