import { z } from "zod";
import { decodeBuyerFromUserData } from "./celo-events.js";
import { RuntimeConfig } from "./env.js";
import { errorMessage, logError, logInfo, logWarn, redactAddress } from "./logging.js";

export const SUPERFLUID_CELO_SUBGRAPH_URL = "https://subgraph-endpoints.superfluid.dev/celo-mainnet/protocol-v1";

const PAGE_SIZE = 1000;

const StreamPeriodsResponseSchema = z.object({
  data: z.object({
    _meta: z.object({ block: z.object({ timestamp: z.coerce.number().int().positive() }) }),
    streamPeriods: z.array(
      z.object({
        id: z.string().min(1),
        sender: z.object({ id: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }),
        flowRate: z.string().regex(/^\d+$/),
        startedAtTimestamp: z.string().regex(/^\d+$/),
        stoppedAtTimestamp: z.string().regex(/^\d+$/).nullable(),
        startedAtEvent: z.object({ userData: z.string() }).nullable()
      })
    )
  })
});

/** One constant-rate segment of a Superfluid stream into the vault. Timestamps are unix seconds. */
export type StreamPeriod = {
  id: string;
  account: string;
  flowRateWeiPerSecond: bigint;
  startedAt: number;
  /** Undefined while the period is still flowing. */
  stoppedAt?: number;
  /** AntSeed buyer from the userData of the flow update that opened this period. */
  buyerAddress?: string;
};

export type StreamPeriodsSnapshot = {
  /** Timestamp of the block the subgraph had indexed; the end of every window credited from this snapshot. */
  asOf: number;
  periods: StreamPeriod[];
};

/**
 * Every stream period into the vault that can still owe credit: all open periods, plus closed ones that
 * stopped after `closedAfter`. Periods that stopped at or before it are known to be settled and are not
 * fetched again.
 *
 * Returns undefined when the subgraph is unreachable or misconfigured, so the caller skips the run
 * instead of reading "no periods" as "nothing is streaming".
 */
export async function fetchStreamPeriods(cfg: RuntimeConfig, closedAfter: number): Promise<StreamPeriodsSnapshot | undefined> {
  if (!cfg.CELO_VAULT_ADDRESS || !cfg.CELO_GD_SUPERTOKEN_ADDRESS) {
    logWarn("superfluid.periods.skipped", {
      reason: "missing_config",
      hasVaultAddress: Boolean(cfg.CELO_VAULT_ADDRESS),
      hasSuperTokenAddress: Boolean(cfg.CELO_GD_SUPERTOKEN_ADDRESS)
    });
    return undefined;
  }

  const endpoint = cfg.SUPERFLUID_SUBGRAPH_URL ?? SUPERFLUID_CELO_SUBGRAPH_URL;
  const receiver = cfg.CELO_VAULT_ADDRESS.toLowerCase();
  const token = cfg.CELO_GD_SUPERTOKEN_ADDRESS.toLowerCase();
  const periods: StreamPeriod[] = [];
  let asOf: number | undefined;
  let lastId = "";
  let pages = 0;

  try {
    while (true) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // `or` branches must each carry every condition: the subgraph rejects mixing them with
          // top-level fields. Keyset pagination on `id` rather than `skip`, which graph-node caps.
          query: `
            query VaultStreamPeriods($receiver: String!, $token: String!, $closedAfter: BigInt!, $lastId: String!, $first: Int!) {
              _meta { block { timestamp } }
              streamPeriods(
                first: $first
                orderBy: id
                orderDirection: asc
                where: {
                  or: [
                    { receiver: $receiver, token: $token, id_gt: $lastId, stoppedAtTimestamp: null }
                    { receiver: $receiver, token: $token, id_gt: $lastId, stoppedAtTimestamp_gt: $closedAfter }
                  ]
                }
              ) {
                id
                sender { id }
                flowRate
                startedAtTimestamp
                stoppedAtTimestamp
                startedAtEvent { userData }
              }
            }
          `,
          variables: { receiver, token, closedAfter: closedAfter.toString(), lastId, first: PAGE_SIZE }
        })
      });
      if (!response.ok) throw new Error(`Superfluid subgraph HTTP ${response.status}`);

      const parsed = StreamPeriodsResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("invalid Superfluid subgraph response shape");

      asOf ??= parsed.data.data._meta.block.timestamp;
      const batch = parsed.data.data.streamPeriods;
      for (const period of batch) {
        periods.push({
          id: period.id,
          account: period.sender.id.toLowerCase(),
          flowRateWeiPerSecond: BigInt(period.flowRate),
          startedAt: Number(period.startedAtTimestamp),
          stoppedAt: period.stoppedAtTimestamp === null ? undefined : Number(period.stoppedAtTimestamp),
          buyerAddress: decodeBuyerFromUserData(period.startedAtEvent?.userData)
        });
      }
      pages += 1;
      if (batch.length < PAGE_SIZE) break;
      lastId = batch[batch.length - 1].id;
    }
  } catch (error) {
    logError("superfluid.periods.fetch.failed", {
      endpoint,
      receiver: redactAddress(receiver),
      token: redactAddress(token),
      message: errorMessage(error)
    });
    return undefined;
  }

  logInfo("superfluid.periods.fetch.end", { endpoint, closedAfter, asOf, pages, count: periods.length });
  return { asOf: asOf!, periods };
}

/**
 * G$ an account's periods carried in the window `(creditedThrough, asOf]`: each period's rate times
 * the seconds it overlaps that window. Gaps between periods (a closed stream, a later re-open) have no
 * period and so contribute nothing.
 */
export function streamOwedWei(periods: StreamPeriod[], creditedThrough: number, asOf: number): bigint {
  let owed = 0n;
  for (const period of periods) {
    const start = Math.max(period.startedAt, creditedThrough);
    const end = Math.min(period.stoppedAt ?? asOf, asOf);
    if (end > start) owed += period.flowRateWeiPerSecond * BigInt(end - start);
  }
  return owed;
}

/** Combined rate of the account's open periods; 0 once every stream has closed. */
export function liveFlowRate(periods: StreamPeriod[]): bigint {
  return periods.reduce((sum, period) => (period.stoppedAt === undefined ? sum + period.flowRateWeiPerSecond : sum), 0n);
}

/** Buyer named by the account's most recent flow update. */
export function latestBuyerAddress(periods: StreamPeriod[]): string | undefined {
  let latest: StreamPeriod | undefined;
  for (const period of periods) {
    if (!latest || period.startedAt > latest.startedAt) latest = period;
  }
  return latest?.buyerAddress;
}

/**
 * Earliest stop time among closed periods that still owe credit past `creditedThrough`, or undefined
 * when every closed period is settled. Bounds how far the closed-periods cursor may advance.
 */
export function earliestUnsettledStop(periods: StreamPeriod[], creditedThrough: number): number | undefined {
  let earliest: number | undefined;
  for (const period of periods) {
    if (period.stoppedAt === undefined || period.stoppedAt <= Math.max(period.startedAt, creditedThrough)) continue;
    if (earliest === undefined || period.stoppedAt < earliest) earliest = period.stoppedAt;
  }
  return earliest;
}
