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
  constructor(private readonly kv: KV) {}

  async reserve(account: string, maxCostMicroUsd: bigint, rootAccount?: string): Promise<CreditReservation> {
    const requestId = crypto.randomUUID();
    const now = new Date().toISOString();
    const reservation: CreditReservation = {
      requestId,
      account: normalizeAccount(account),
      rootAccount: normalizeAccount(rootAccount ?? account),
      maxCostMicroUsd: maxCostMicroUsd.toString(),
      status: "reserved",
      createdAt: now,
      updatedAt: now
    };

    const profile = await this.getUser(reservation.rootAccount!);
    if (BigInt(profile.creditBalanceMicroUsd) < maxCostMicroUsd) {
      throw new Error(`insufficient credit balance for ${reservation.account}`);
    }

    await this.putReservation(reservation);
    await this.addRequestToAccount(reservation.account, requestId);
    await this.addRequestToAccount(reservation.rootAccount!, requestId);
    await this.updateUser(reservation.account, reservation.rootAccount, (current) => ({
      ...current,
      updatedAt: now,
      totalRequests: current.totalRequests + 1,
      totalReservedMicroUsd: addDecimalStrings(current.totalReservedMicroUsd, reservation.maxCostMicroUsd),
      reservedCreditMicroUsd: addDecimalStrings(current.reservedCreditMicroUsd, reservation.maxCostMicroUsd),
      creditBalanceMicroUsd: subtractDecimalStrings(current.creditBalanceMicroUsd, reservation.maxCostMicroUsd),
      lastRequestId: requestId
    }));

    return reservation;
  }

  async markVaultReserved(requestId: string, vaultReserveTxHash?: string): Promise<CreditReservation> {
    const reservation = await this.requireReservation(requestId);
    reservation.vaultReserveTxHash = vaultReserveTxHash;
    reservation.updatedAt = new Date().toISOString();
    await this.putReservation(reservation);
    return reservation;
  }

  async settle(
    requestId: string,
    actualCostMicroUsd: bigint,
    providerReceiptHash?: string,
    vaultSettleTxHash?: string
  ): Promise<CreditReservation> {
    const reservation = await this.requireReservation(requestId);
    if (reservation.status !== "reserved") throw new Error(`request ${requestId} is not reserved`);

    const now = new Date().toISOString();
    reservation.status = "settled";
    reservation.actualCostMicroUsd = actualCostMicroUsd.toString();
    reservation.providerReceiptHash = providerReceiptHash;
    reservation.vaultSettleTxHash = vaultSettleTxHash;
    reservation.updatedAt = now;
    await this.putReservation(reservation);

    const refund = BigInt(reservation.maxCostMicroUsd) > actualCostMicroUsd
      ? BigInt(reservation.maxCostMicroUsd) - actualCostMicroUsd
      : 0n;
    await this.updateUser(reservation.account, reservation.rootAccount, (profile) => ({
      ...profile,
      updatedAt: now,
      totalSettledMicroUsd: addDecimalStrings(profile.totalSettledMicroUsd, reservation.actualCostMicroUsd ?? "0"),
      reservedCreditMicroUsd: subtractDecimalStrings(profile.reservedCreditMicroUsd, reservation.maxCostMicroUsd),
      creditBalanceMicroUsd: addDecimalStrings(profile.creditBalanceMicroUsd, refund.toString()),
      lastRequestId: requestId
    }));

    return reservation;
  }

  async release(requestId: string, vaultReleaseTxHash?: string): Promise<CreditReservation> {
    const reservation = await this.requireReservation(requestId);
    if (reservation.status !== "reserved") throw new Error(`request ${requestId} is not reserved`);
    const now = new Date().toISOString();
    reservation.status = "released";
    reservation.vaultReleaseTxHash = vaultReleaseTxHash;
    reservation.updatedAt = now;
    await this.putReservation(reservation);
    await this.updateUser(reservation.account, reservation.rootAccount, (profile) => ({
      ...profile,
      updatedAt: now,
      reservedCreditMicroUsd: subtractDecimalStrings(profile.reservedCreditMicroUsd, reservation.maxCostMicroUsd),
      creditBalanceMicroUsd: addDecimalStrings(profile.creditBalanceMicroUsd, reservation.maxCostMicroUsd)
    }));
    return reservation;
  }

  async updateStream(
    account: string,
    rootAccount: string | undefined,
    flowRateWeiPerSecond: bigint,
    gdMicroUsdPerToken: bigint,
    monthlyGdAmountWei?: bigint,
    txHash?: string,
    logIndex?: number
  ): Promise<StreamState> {
    const normalized = normalizeAccount(account);
    const normalizedRoot = normalizeAccount(rootAccount ?? account);
    const monthlyGd = monthlyGdAmountWei ?? flowRateWeiPerSecond * BigInt(30 * 24 * 60 * 60);
    const monthlyUsd = monthlyStreamMicroUsd(flowRateWeiPerSecond, gdMicroUsdPerToken);
    const now = new Date().toISOString();
    const previous = await this.getStream(normalized);
    const state: StreamState = {
      account: normalized,
      rootAccount: normalizedRoot,
      flowRateWeiPerSecond: flowRateWeiPerSecond.toString(),
      monthlyGdAmountWei: monthlyGd.toString(),
      monthlyMicroUsd: monthlyUsd.toString(),
      active: flowRateWeiPerSecond > 0n,
      lastBonusPaidAt: previous?.active ? previous.lastBonusPaidAt : now,
      txHash,
      logIndex,
      updatedAt: now
    };
    await this.putJson(`${STREAM_PREFIX}${normalized}`, state);
    await this.putJson(`${STREAM_PREFIX}${normalizedRoot}`, state);
    await this.addStreamToIndex(normalizedRoot);
    await this.updateUser(normalized, normalizedRoot, (profile) => ({
      ...profile,
      updatedAt: now,
      streamFlowRateWeiPerSecond: state.flowRateWeiPerSecond,
      streamMonthlyMicroUsd: state.monthlyMicroUsd
    }));
    return state;
  }

  async settleStreamBonusOnFlowChange(
    account: string,
    nextFlowRateWeiPerSecond: bigint,
    txHash?: string,
    logIndex?: number,
    now = new Date()
  ): Promise<GdCreditEntry | undefined> {
    const stream = await this.getStream(account);
    if (!stream) return undefined;
    const previousFlowRate = BigInt(stream.flowRateWeiPerSecond);
    if (previousFlowRate <= 0n || previousFlowRate === nextFlowRateWeiPerSecond) return undefined;
    const nowMs = now.getTime();
    const paidAtMs = Date.parse(stream.lastBonusPaidAt);
    if (!Number.isFinite(paidAtMs) || nowMs <= paidAtMs) return undefined;
    const createdAt = now.toISOString();
    const credit = await this.recordStreamBonusCredit({
      account: stream.account,
      rootAccount: stream.rootAccount,
      monthlyGdAmountWei: BigInt(stream.monthlyGdAmountWei),
      monthlyMicroUsd: BigInt(stream.monthlyMicroUsd),
      elapsedSeconds: BigInt(Math.floor((nowMs - paidAtMs) / 1000)),
      txHash,
      logIndex,
      createdAt
    });
    if (!credit) return undefined;
    stream.lastBonusPaidAt = createdAt;
    stream.updatedAt = createdAt;
    await this.putJson(`${STREAM_PREFIX}${stream.account}`, stream);
    await this.putJson(`${STREAM_PREFIX}${stream.rootAccount}`, stream);
    return credit;
  }

  async settleDueStreamBonus(account: string, now = new Date()): Promise<GdCreditEntry | undefined> {
    const stream = await this.getStream(account);
    if (!stream?.active) return undefined;
    const nowMs = now.getTime();
    const paidAtMs = Date.parse(stream.lastBonusPaidAt);
    if (!Number.isFinite(paidAtMs)) return undefined;
    if (nowMs - paidAtMs < Number(STREAM_MONTH_SECONDS) * 1000) return undefined;
    const elapsedSeconds = BigInt(Math.floor((nowMs - paidAtMs) / 1000));
    const credit = await this.recordStreamBonusCredit({
      account: stream.account,
      rootAccount: stream.rootAccount,
      monthlyGdAmountWei: BigInt(stream.monthlyGdAmountWei),
      monthlyMicroUsd: BigInt(stream.monthlyMicroUsd),
      elapsedSeconds,
      createdAt: now.toISOString()
    });
    if (credit) {
      stream.lastBonusPaidAt = now.toISOString();
      stream.updatedAt = now.toISOString();
      await this.putJson(`${STREAM_PREFIX}${stream.account}`, stream);
      await this.putJson(`${STREAM_PREFIX}${stream.rootAccount}`, stream);
    }
    return credit;
  }

  async recordGdCredit(input: {
    account: string;
    rootAccount?: string;
    source: GdCreditEntry["source"];
    gdAmountWei: bigint;
    principalMicroUsd: bigint;
    txHash?: string;
    logIndex?: number;
    date?: Date;
  }): Promise<GdCreditEntry> {
    const account = normalizeAccount(input.account);
    const rootAccount = normalizeAccount(input.rootAccount ?? input.account);
    const month = monthKey(input.date ?? new Date());
    const usedKey = `${STREAM_BONUS_USED_PREFIX}${rootAccount}:${month}`;
    const profile = await this.getUser(rootAccount);
    const used = BigInt((await this.kv.get(usedKey)) ?? "0");
    const bonus = calculateCreditWithBonus({
      principalMicroUsd: input.principalMicroUsd,
      monthlyStreamCapMicroUsd: BigInt(profile.streamMonthlyMicroUsd),
      streamingBonusUsedMicroUsd: used
    });

    const now = new Date().toISOString();
    const entry: GdCreditEntry = {
      id: crypto.randomUUID(),
      account,
      rootAccount,
      source: input.source,
      gdAmountWei: input.gdAmountWei.toString(),
      principalMicroUsd: bonus.principalMicroUsd.toString(),
      regularBonusMicroUsd: bonus.regularBonusMicroUsd.toString(),
      streamingBonusMicroUsd: bonus.streamingBonusMicroUsd.toString(),
      totalCreditMicroUsd: bonus.totalCreditMicroUsd.toString(),
      streamingBonusPrincipalAppliedMicroUsd: bonus.streamingBonusPrincipalAppliedMicroUsd.toString(),
      month,
      txHash: input.txHash,
      logIndex: input.logIndex,
      fundingStatus: "pending",
      createdAt: now
    };

    await this.putJson(`${GD_CREDIT_PREFIX}${entry.id}`, entry);
    await this.addGdCreditToAccount(account, entry.id);
    await this.addGdCreditToAccount(rootAccount, entry.id);
    await this.kv.put(usedKey, (used + bonus.streamingBonusPrincipalAppliedMicroUsd).toString());
    await this.updateUser(account, rootAccount, (current) => ({
      ...current,
      updatedAt: now,
      totalGdDepositedWei: addDecimalStrings(current.totalGdDepositedWei, entry.gdAmountWei),
      totalGdPrincipalMicroUsd: addDecimalStrings(current.totalGdPrincipalMicroUsd, entry.principalMicroUsd),
      totalGdCreditsIssuedMicroUsd: addDecimalStrings(current.totalGdCreditsIssuedMicroUsd, entry.totalCreditMicroUsd),
      totalRegularBonusMicroUsd: addDecimalStrings(current.totalRegularBonusMicroUsd, entry.regularBonusMicroUsd),
      totalStreamingBonusMicroUsd: addDecimalStrings(current.totalStreamingBonusMicroUsd, entry.streamingBonusMicroUsd),
      totalOutstandingFundingMicroUsd: addDecimalStrings(current.totalOutstandingFundingMicroUsd, entry.totalCreditMicroUsd),
      creditBalanceMicroUsd: addDecimalStrings(current.creditBalanceMicroUsd, entry.totalCreditMicroUsd)
    }));

    return entry;
  }

  async markFundingResult(entryId: string, result: { funded: boolean; id?: string; txHash?: string; error?: string }): Promise<GdCreditEntry> {
    const key = `${GD_CREDIT_PREFIX}${entryId}`;
    const entry = await this.getJson<GdCreditEntry>(key);
    if (!entry) throw new Error(`unknown gd credit ${entryId}`);
    if (entry.fundingStatus === "funded" || entry.fundingStatus === "failed") return entry;

    entry.fundingStatus = result.funded ? "funded" : "failed";
    entry.fundingId = result.id;
    entry.fundingTxHash = result.txHash;
    entry.fundingError = result.error;
    await this.putJson(key, entry);

    if (result.funded) {
      const now = new Date().toISOString();
      await this.updateUser(entry.account, entry.rootAccount, (current) => ({
        ...current,
        updatedAt: now,
        totalOutstandingFundingMicroUsd: subtractDecimalStrings(current.totalOutstandingFundingMicroUsd, entry.totalCreditMicroUsd),
        totalOutstandingStreamBonusMicroUsd: entry.source === "stream"
          ? subtractDecimalStrings(current.totalOutstandingStreamBonusMicroUsd, entry.totalCreditMicroUsd)
          : current.totalOutstandingStreamBonusMicroUsd
      }));
    }
    return entry;
  }

  async withdrawPrincipal(account: string, amountMicroUsd: bigint): Promise<UserCreditProfile> {
    const normalized = normalizeAccount(account);
    if (amountMicroUsd <= 0n) throw new Error("amount must be positive");
    const profile = await this.getUser(normalized);
    const principal = BigInt(profile.totalGdPrincipalMicroUsd);
    const withdrawn = BigInt(profile.totalWithdrawnPrincipalMicroUsd);
    const maxWithdrawable = principal > withdrawn ? principal - withdrawn : 0n;
    if (amountMicroUsd > maxWithdrawable) {
      throw new Error(`insufficient deposited principal (max withdrawable: ${maxWithdrawable})`);
    }
    if (amountMicroUsd > BigInt(profile.creditBalanceMicroUsd)) {
      throw new Error(`insufficient credit balance (available: ${profile.creditBalanceMicroUsd})`);
    }
    const now = new Date().toISOString();
    const updated: UserCreditProfile = {
      ...profile,
      updatedAt: now,
      totalWithdrawnPrincipalMicroUsd: addDecimalStrings(profile.totalWithdrawnPrincipalMicroUsd, amountMicroUsd.toString()),
      creditBalanceMicroUsd: subtractDecimalStrings(profile.creditBalanceMicroUsd, amountMicroUsd.toString())
    };
    await this.putJson(`${USER_PREFIX}${normalized}`, updated);
    return updated;
  }

  async getGdCredits(account: string): Promise<GdCreditEntry[]> {
    const normalized = normalizeAccount(account);
    const ids = (await this.getJson<string[]>(`${USER_GD_CREDITS_PREFIX}${normalized}`)) ?? [];
    const entries = await Promise.all(ids.map((id) => this.getJson<GdCreditEntry>(`${GD_CREDIT_PREFIX}${id}`)));
    return entries.filter((item): item is GdCreditEntry => Boolean(item));
  }

  async getStream(account: string): Promise<StreamState | undefined> {
    const normalized = normalizeAccount(account);
    return this.getJson<StreamState>(`${STREAM_PREFIX}${normalized}`);
  }

  async listTrackedStreams(): Promise<StreamState[]> {
    const accounts = (await this.getJson<string[]>(STREAM_INDEX_KEY)) ?? [];
    const streams = await Promise.all(accounts.map((account) => this.getStream(account)));
    return streams.filter((item): item is StreamState => Boolean(item));
  }

  async getReservation(requestId: string): Promise<CreditReservation | undefined> {
    return this.getJson<CreditReservation>(`${REQUEST_PREFIX}${requestId}`);
  }

  async getUser(account: string): Promise<UserCreditProfile> {
    const normalized = normalizeAccount(account);
    const saved = await this.getJson<Partial<UserCreditProfile>>(`${USER_PREFIX}${normalized}`);
    return normalizeProfile(saved, normalized);
  }

  async getUserRequests(account: string): Promise<CreditReservation[]> {
    const normalized = normalizeAccount(account);
    const ids = (await this.getJson<string[]>(`${USER_REQUESTS_PREFIX}${normalized}`)) ?? [];
    const reservations = await Promise.all(ids.map((id) => this.getReservation(id)));
    return reservations.filter((item): item is CreditReservation => Boolean(item));
  }

  private async requireReservation(requestId: string): Promise<CreditReservation> {
    const reservation = await this.getReservation(requestId);
    if (!reservation) throw new Error(`unknown request ${requestId}`);
    return reservation;
  }

  private async putReservation(reservation: CreditReservation): Promise<void> {
    await this.putJson(`${REQUEST_PREFIX}${reservation.requestId}`, reservation);
  }

  private async addRequestToAccount(account: string, requestId: string): Promise<void> {
    const key = `${USER_REQUESTS_PREFIX}${account}`;
    const ids = (await this.getJson<string[]>(key)) ?? [];
    if (!ids.includes(requestId)) ids.push(requestId);
    await this.putJson(key, ids.slice(-500));
  }

  private async addGdCreditToAccount(account: string, entryId: string): Promise<void> {
    const key = `${USER_GD_CREDITS_PREFIX}${account}`;
    const ids = (await this.getJson<string[]>(key)) ?? [];
    if (!ids.includes(entryId)) ids.push(entryId);
    await this.putJson(key, ids.slice(-500));
  }

  private async addStreamToIndex(account: string): Promise<void> {
    const normalized = normalizeAccount(account);
    const streams = (await this.getJson<string[]>(STREAM_INDEX_KEY)) ?? [];
    if (!streams.includes(normalized)) streams.push(normalized);
    await this.putJson(STREAM_INDEX_KEY, streams.slice(-MAX_TRACKED_STREAMS));
  }

  private async recordStreamBonusCredit(input: {
    account: string;
    rootAccount: string;
    monthlyGdAmountWei: bigint;
    monthlyMicroUsd: bigint;
    elapsedSeconds: bigint;
    txHash?: string;
    logIndex?: number;
    createdAt: string;
  }): Promise<GdCreditEntry | undefined> {
    if (input.monthlyGdAmountWei <= 0n || input.monthlyMicroUsd <= 0n || input.elapsedSeconds <= 0n) {
      return undefined;
    }
    // Settle at most one month per credit entry; remaining active-time bonus is handled on later runs.
    const elapsed = input.elapsedSeconds > STREAM_MONTH_SECONDS ? STREAM_MONTH_SECONDS : input.elapsedSeconds;
    const principal = (input.monthlyMicroUsd * elapsed) / STREAM_MONTH_SECONDS;
    if (principal <= 0n) return undefined;
    const gdAmount = (input.monthlyGdAmountWei * elapsed) / STREAM_MONTH_SECONDS;
    const bonus = (principal * STREAM_BONUS_BPS) / BPS;
    const entry: GdCreditEntry = {
      id: crypto.randomUUID(),
      account: input.account,
      rootAccount: input.rootAccount,
      source: "stream",
      gdAmountWei: gdAmount.toString(),
      principalMicroUsd: "0",
      regularBonusMicroUsd: "0",
      streamingBonusMicroUsd: bonus.toString(),
      totalCreditMicroUsd: bonus.toString(),
      streamingBonusPrincipalAppliedMicroUsd: principal.toString(),
      month: monthKey(new Date(input.createdAt)),
      txHash: input.txHash,
      logIndex: input.logIndex,
      fundingStatus: "pending",
      createdAt: input.createdAt
    };
    await this.putJson(`${GD_CREDIT_PREFIX}${entry.id}`, entry);
    await this.addGdCreditToAccount(entry.account, entry.id);
    await this.addGdCreditToAccount(entry.rootAccount, entry.id);
    await this.updateUser(entry.account, entry.rootAccount, (current) => ({
      ...current,
      updatedAt: input.createdAt,
      totalGdCreditsIssuedMicroUsd: addDecimalStrings(current.totalGdCreditsIssuedMicroUsd, entry.totalCreditMicroUsd),
      totalStreamingBonusMicroUsd: addDecimalStrings(current.totalStreamingBonusMicroUsd, entry.streamingBonusMicroUsd),
      totalOutstandingFundingMicroUsd: addDecimalStrings(current.totalOutstandingFundingMicroUsd, entry.totalCreditMicroUsd),
      totalOutstandingStreamBonusMicroUsd: addDecimalStrings(current.totalOutstandingStreamBonusMicroUsd, entry.totalCreditMicroUsd),
      creditBalanceMicroUsd: addDecimalStrings(current.creditBalanceMicroUsd, entry.totalCreditMicroUsd)
    }));
    return entry;
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
    totalRequests: saved?.totalRequests ?? 0,
    totalReservedMicroUsd: saved?.totalReservedMicroUsd ?? "0",
    totalSettledMicroUsd: saved?.totalSettledMicroUsd ?? "0",
    creditBalanceMicroUsd: saved?.creditBalanceMicroUsd ?? "0",
    reservedCreditMicroUsd: saved?.reservedCreditMicroUsd ?? "0",
    totalGdDepositedWei: saved?.totalGdDepositedWei ?? "0",
    totalGdPrincipalMicroUsd: saved?.totalGdPrincipalMicroUsd ?? "0",
    totalGdCreditsIssuedMicroUsd: saved?.totalGdCreditsIssuedMicroUsd ?? "0",
    totalRegularBonusMicroUsd: saved?.totalRegularBonusMicroUsd ?? "0",
    totalStreamingBonusMicroUsd: saved?.totalStreamingBonusMicroUsd ?? "0",
    totalOutstandingFundingMicroUsd: saved?.totalOutstandingFundingMicroUsd ?? "0",
    totalOutstandingStreamBonusMicroUsd: saved?.totalOutstandingStreamBonusMicroUsd ?? "0",
    totalWithdrawnPrincipalMicroUsd: saved?.totalWithdrawnPrincipalMicroUsd ?? "0",
    streamFlowRateWeiPerSecond: saved?.streamFlowRateWeiPerSecond ?? "0",
    streamMonthlyMicroUsd: saved?.streamMonthlyMicroUsd ?? "0",
    lastRequestId: saved?.lastRequestId
  };
}

function normalizeAccount(account: string): string {
  return account.toLowerCase();
}

function addDecimalStrings(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

function subtractDecimalStrings(a: string, b: string): string {
  const result = BigInt(a) - BigInt(b);
  return (result > 0n ? result : 0n).toString();
}
