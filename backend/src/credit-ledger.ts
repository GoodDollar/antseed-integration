import { randomUUID } from "node:crypto";
import { CreditReservation } from "./types.js";

export class CreditLedger {
  private reservations = new Map<string, CreditReservation>();

  reserve(account: string, maxCostMicroUsd: bigint): CreditReservation {
    const now = new Date().toISOString();
    const reservation: CreditReservation = {
      requestId: randomUUID(),
      account,
      maxCostMicroUsd,
      status: "reserved",
      createdAt: now,
      updatedAt: now
    };
    this.reservations.set(reservation.requestId, reservation);
    return reservation;
  }

  settle(requestId: string, actualCostMicroUsd: bigint, providerReceiptHash?: string): CreditReservation {
    const reservation = this.requireReservation(requestId);
    if (reservation.status !== "reserved") throw new Error(`request ${requestId} is not reserved`);
    reservation.status = "settled";
    reservation.actualCostMicroUsd = actualCostMicroUsd;
    reservation.providerReceiptHash = providerReceiptHash;
    reservation.updatedAt = new Date().toISOString();
    return reservation;
  }

  release(requestId: string): CreditReservation {
    const reservation = this.requireReservation(requestId);
    if (reservation.status !== "reserved") throw new Error(`request ${requestId} is not reserved`);
    reservation.status = "released";
    reservation.updatedAt = new Date().toISOString();
    return reservation;
  }

  get(requestId: string): CreditReservation | undefined {
    return this.reservations.get(requestId);
  }

  byAccount(account: string): CreditReservation[] {
    const normalized = account.toLowerCase();
    return [...this.reservations.values()].filter((r) => r.account.toLowerCase() === normalized);
  }

  private requireReservation(requestId: string): CreditReservation {
    const reservation = this.reservations.get(requestId);
    if (!reservation) throw new Error(`unknown request ${requestId}`);
    return reservation;
  }
}
