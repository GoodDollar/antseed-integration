import { calculateCreditWithBonus, monthKey, monthlyStreamMicroUsd } from "./credit-bonus.js";
import { CreditReservation, GdCreditEntry, StreamState, UserCreditProfile } from "./types.js";

type KV = Pick<KVNamespace, "get" | "put">;

const USER_PREFIX = "user:";
const REQUEST_PREFIX = "request:";
const USER_REQUESTS_PREFIX = "user-requests:";
const GD_CREDIT_PREFIX = "gd-credit:";
const GD_CREDIT_EVENT_PREFIX = "gd-credit-event:";
const USER_GD_CREDITS_PREFIX = "user-gd-credits:";
const STREAM_PREFIX = "stream:";
const STREAM_BONUS_USED_PREFIX = "stream-bonus-used:";

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
    const state: StreamState = {
      account: normalized,
      rootAccount: normalizedRoot,
      flowRateWeiPerSecond: flowRateWeiPerSecond.toString(),
      monthlyGdAmountWei: monthlyGd.toString(),
      monthlyMicroUsd: monthlyUsd.toString(),
      txHash,
      logIndex,
      updatedAt: now
    };
    await this.putJson(`${STREAM_PREFIX}${normalized}`, state);
    await this.putJson(`${STREAM_PREFIX}${normalizedRoot}`, state);
    await this.updateUser(normalized, normalizedRoot, (profile) => ({
      ...profile,
      updatedAt: now,
      streamFlowRateWeiPerSecond: state.flowRateWeiPerSecond,
      streamMonthlyMicroUsd: state.monthlyMicroUsd
    }));
    return state;
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
    const { entry } = await this.recordGdCreditWithMeta(input);
    return entry;
  }

  async recordGdCreditWithMeta(input: {
    account: string;
    rootAccount?: string;
    source: GdCreditEntry["source"];
    gdAmountWei: bigint;
    principalMicroUsd: bigint;
    txHash?: string;
    logIndex?: number;
    date?: Date;
  }): Promise<{ entry: GdCreditEntry; isDuplicate: boolean }> {
    const account = normalizeAccount(input.account);
    const rootAccount = normalizeAccount(input.rootAccount ?? input.account);
    const eventKey = eventCreditKey(input.txHash, input.logIndex);
    if (eventKey) {
      const existingId = await this.kv.get(`${GD_CREDIT_EVENT_PREFIX}${eventKey}`);
      if (existingId) {
        const existing = await this.getJson<GdCreditEntry>(`${GD_CREDIT_PREFIX}${existingId}`);
        if (existing) return { entry: existing, isDuplicate: true };
      }
    }
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
      createdAt: now
    };

    await this.putJson(`${GD_CREDIT_PREFIX}${entry.id}`, entry);
    if (eventKey) await this.kv.put(`${GD_CREDIT_EVENT_PREFIX}${eventKey}`, entry.id);
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
      creditBalanceMicroUsd: addDecimalStrings(current.creditBalanceMicroUsd, entry.totalCreditMicroUsd)
    }));

    return { entry, isDuplicate: false };
  }

  async getGdCreditByEvent(txHash: string, logIndex: number): Promise<GdCreditEntry | undefined> {
    const key = eventCreditKey(txHash, logIndex);
    if (!key) return undefined;
    const id = await this.kv.get(`${GD_CREDIT_EVENT_PREFIX}${key}`);
    if (!id) return undefined;
    return this.getJson<GdCreditEntry>(`${GD_CREDIT_PREFIX}${id}`);
  }

  async markGdCreditBridged(entryId: string, bridgeDepositTxHash?: string): Promise<GdCreditEntry | undefined> {
    const key = `${GD_CREDIT_PREFIX}${entryId}`;
    const entry = await this.getJson<GdCreditEntry>(key);
    if (!entry) return undefined;
    const updated: GdCreditEntry = {
      ...entry,
      bridgeDepositTxHash,
      bridgeDepositedAt: new Date().toISOString()
    };
    await this.putJson(key, updated);
    return updated;
  }

  async getGdCredits(account: string): Promise<GdCreditEntry[]> {
    const normalized = normalizeAccount(account);
    const ids = (await this.getJson<string[]>(`${USER_GD_CREDITS_PREFIX}${normalized}`)) ?? [];
    const entries = await Promise.all(ids.map((id) => this.getJson<GdCreditEntry>(`${GD_CREDIT_PREFIX}${id}`)));
    return entries.filter((item): item is GdCreditEntry => Boolean(item));
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

function eventCreditKey(txHash: string | undefined, logIndex: number | undefined): string | undefined {
  if (!txHash || logIndex === undefined) return undefined;
  return `${txHash.toLowerCase()}:${logIndex}`;
}
