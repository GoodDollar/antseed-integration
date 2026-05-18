import { CreditReservation, UserCreditProfile } from "./types.js";

type KV = Pick<KVNamespace, "get" | "put">;

const USER_PREFIX = "user:";
const REQUEST_PREFIX = "request:";
const USER_REQUESTS_PREFIX = "user-requests:";

export class KVCreditStore {
  constructor(private readonly kv: KV) {}

  async reserve(account: string, maxCostMicroUsd: bigint): Promise<CreditReservation> {
    const requestId = crypto.randomUUID();
    const now = new Date().toISOString();
    const reservation: CreditReservation = {
      requestId,
      account: normalizeAccount(account),
      maxCostMicroUsd: maxCostMicroUsd.toString(),
      status: "reserved",
      createdAt: now,
      updatedAt: now
    };

    await this.putReservation(reservation);
    await this.addRequestToAccount(reservation.account, requestId);
    await this.updateUser(reservation.account, (profile) => ({
      ...profile,
      updatedAt: now,
      totalRequests: profile.totalRequests + 1,
      totalReservedMicroUsd: addDecimalStrings(profile.totalReservedMicroUsd, reservation.maxCostMicroUsd),
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

    await this.updateUser(reservation.account, (profile) => ({
      ...profile,
      updatedAt: now,
      totalSettledMicroUsd: addDecimalStrings(profile.totalSettledMicroUsd, reservation.actualCostMicroUsd ?? "0"),
      lastRequestId: requestId
    }));

    return reservation;
  }

  async release(requestId: string, vaultReleaseTxHash?: string): Promise<CreditReservation> {
    const reservation = await this.requireReservation(requestId);
    if (reservation.status !== "reserved") throw new Error(`request ${requestId} is not reserved`);
    reservation.status = "released";
    reservation.vaultReleaseTxHash = vaultReleaseTxHash;
    reservation.updatedAt = new Date().toISOString();
    await this.putReservation(reservation);
    return reservation;
  }

  async getReservation(requestId: string): Promise<CreditReservation | undefined> {
    return this.getJson<CreditReservation>(`${REQUEST_PREFIX}${requestId}`);
  }

  async getUser(account: string): Promise<UserCreditProfile> {
    const normalized = normalizeAccount(account);
    return (await this.getJson<UserCreditProfile>(`${USER_PREFIX}${normalized}`)) ?? newUserProfile(normalized);
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

  private async updateUser(account: string, mutate: (profile: UserCreditProfile) => UserCreditProfile): Promise<void> {
    const current = await this.getUser(account);
    await this.putJson(`${USER_PREFIX}${current.account}`, mutate(current));
  }

  private async getJson<T>(key: string): Promise<T | undefined> {
    const value = await this.kv.get(key, "json");
    return (value ?? undefined) as T | undefined;
  }

  private async putJson(key: string, value: unknown): Promise<void> {
    await this.kv.put(key, JSON.stringify(value));
  }
}

function newUserProfile(account: string): UserCreditProfile {
  const now = new Date().toISOString();
  return {
    account,
    createdAt: now,
    updatedAt: now,
    totalRequests: 0,
    totalReservedMicroUsd: "0",
    totalSettledMicroUsd: "0"
  };
}

function normalizeAccount(account: string): string {
  return account.toLowerCase();
}

function addDecimalStrings(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}
