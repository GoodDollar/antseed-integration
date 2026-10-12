import { z } from "zod";
import { decodeBuyerFromUserData } from "./celo-events.js";
import { configFromEnv } from "./env.js";
import { errorMessage, logError, logInfo, logWarn, redactAddress } from "./logging.js";

/** Upper bound on constant-rate spans fetched per stream; a truncated list is logged, not silently dropped. */
const PERIOD_PAGE_SIZE = 1000;

/** Default endpoint, used when `SUPERFLUID_SUBGRAPH_URL` is unset. */
export const SUPERFLUID_CELO_SUBGRAPH_URL = "https://subgraph-endpoints.superfluid.dev/celo-mainnet/protocol-v1";

const SuperfluidStreamsResponseSchema = z.object({
  data: z.object({
    streams: z.array(
      z.object({
        sender: z.object({ id: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }),
        currentFlowRate: z.string().regex(/^\d+$/),
        updatedAtTimestamp: z.string().regex(/^\d+$/),
        // Optional with an empty default: a subgraph that stops returning the field, or returns a
        // shape we do not expect, must degrade to "no periods, no credit" rather than failing the
        // whole response and silently blinding the scheduled run to every stream.
        streamPeriods: z
          .array(
            z.object({
              startedAtTimestamp: z.string().regex(/^\d+$/),
              stoppedAtTimestamp: z.string().regex(/^\d+$/).nullable(),
              flowRate: z.string().regex(/^\d+$/)
            })
          )
          .default([]),
        flowUpdatedEvents: z.array(
          z.object({
            userData: z.string()
          })
        )
      })
    )
  })
});

/**
 * A span during which the stream carried a constant rate. Superfluid closes one and opens another
 * on every rate change, so `flowRate * overlap` is exact for any sub-interval of a period -- no
 * rate has to be remembered or assumed to have held.
 */
export type StreamPeriod = {
  startedAtMs: number;
  /** null while the period is still running. */
  stoppedAtMs: number | null;
  flowRateWeiPerSecond: bigint;
};

export type SuperfluidIncomingStream = {
  account: string;
  flowRateWeiPerSecond: string;
  /** For a closed stream this is its termination; for a live one, its last on-chain change. */
  lastUpdateAt: string;
  /** Constant-rate spans, newest first. The exact record of what this stream carried. */
  periods: StreamPeriod[];
  /** AntSeed buyer decoded from the most recent FlowUpdatedEvent userdata. */
  buyerAddress?: string;
};

/**
 * Every stream to the vault, closed ones included. The scheduled run needs the closed rows: a
 * terminated stream reports `currentFlowRate = 0`, which is how the backend learns it stopped.
 */
export async function fetchSuperfluidIncomingStreams(cfg: ReturnType<typeof configFromEnv>): Promise<SuperfluidIncomingStream[]> {
  return fetchSuperfluidStreams(cfg, undefined, true);
}

/** Active streams for one account; callers here use it to answer "is this account streaming now". */
export async function fetchSuperfluidStreamsForAccount(
  account: string,
  cfg: ReturnType<typeof configFromEnv>,
  includeClosed = false
): Promise<SuperfluidIncomingStream[]> {
  return fetchSuperfluidStreams(cfg, account, includeClosed);
}

export async function fetchSuperfluidStreams(
  cfg: ReturnType<typeof configFromEnv>,
  senderFilter?: string,
  includeClosed = false
): Promise<SuperfluidIncomingStream[]> {
  if (!cfg.CELO_VAULT_ADDRESS || !cfg.CELO_GD_SUPERTOKEN_ADDRESS) {
    logWarn("superfluid.streams.skipped", {
      reason: "missing_config",
      hasVaultAddress: Boolean(cfg.CELO_VAULT_ADDRESS),
      hasSuperTokenAddress: Boolean(cfg.CELO_GD_SUPERTOKEN_ADDRESS),
      senderFilter: redactAddress(senderFilter)
    });
    return [];
  }

  const endpoint = cfg.SUPERFLUID_SUBGRAPH_URL ?? SUPERFLUID_CELO_SUBGRAPH_URL;
  const receiver = cfg.CELO_VAULT_ADDRESS.toLowerCase();
  const token = cfg.CELO_GD_SUPERTOKEN_ADDRESS.toLowerCase();
  const pageSize = 500;
  let skip = 0;
  const streams: SuperfluidIncomingStream[] = [];
  let pages = 0;

  logInfo("superfluid.streams.fetch.start", {
    endpoint,
    receiver: redactAddress(receiver),
    token: redactAddress(token),
    senderFilter: redactAddress(senderFilter)
  });

  try {
    while (true) {
      const filters = ["receiver: $receiver", "token: $token"];
      if (!includeClosed) filters.push(`currentFlowRate_gt: "0"`);
      if (senderFilter) filters.push("sender: $sender");
      const whereClause = `{ ${filters.join(", ")} }`;
      const queryParams = senderFilter
        ? `$receiver: String!, $token: String!, $first: Int!, $skip: Int!, $sender: String!`
        : `$receiver: String!, $token: String!, $first: Int!, $skip: Int!`;
      const variables: Record<string, unknown> = {
        receiver,
        token,
        first: pageSize,
        skip
      };
      if (senderFilter) variables.sender = senderFilter.toLowerCase();

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          query: `
            query ActiveIncomingStreams(${queryParams}) {
              streams(
                first: $first
                skip: $skip
                where: ${whereClause}
                orderBy: updatedAtTimestamp
                orderDirection: desc
              ) {
                sender { id }
                currentFlowRate
                updatedAtTimestamp
                streamPeriods(orderBy: startedAtTimestamp, orderDirection: desc, first: ${PERIOD_PAGE_SIZE}) {
                  startedAtTimestamp
                  stoppedAtTimestamp
                  flowRate
                }
                flowUpdatedEvents(orderBy: timestamp, orderDirection: desc, first: 1) {
                  userData
                }
              }
            }
          `,
          variables
        })
      });

      if (!response.ok) {
        throw new Error(`Superfluid subgraph HTTP ${response.status}`);
      }

      const body = await response.json();
      const parsed = SuperfluidStreamsResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error("invalid Superfluid subgraph response shape");
      }

      const batch = parsed.data.data.streams.map((stream) => {
        const flowRateWeiPerSecond = stream.currentFlowRate;
        const updatedAtSeconds = Number(stream.updatedAtTimestamp);
        // A zero `updatedAtTimestamp` must not become 1970: this is the baseline for an account's
        // first stream credit, so a 1970 value makes that credit window decades wide.
        const hasUsableUpdatedAt = Number.isFinite(updatedAtSeconds) && updatedAtSeconds > 0;
        const lastUpdateAt = hasUsableUpdatedAt ? new Date(updatedAtSeconds * 1000).toISOString() : new Date().toISOString();
        if (stream.streamPeriods.length === PERIOD_PAGE_SIZE) {
          logWarn("superfluid.streams.periods-truncated", {
            sender: redactAddress(stream.sender.id),
            pageSize: PERIOD_PAGE_SIZE
          });
        }
        const periods: StreamPeriod[] = stream.streamPeriods.map((period) => ({
          startedAtMs: Number(period.startedAtTimestamp) * 1000,
          stoppedAtMs: period.stoppedAtTimestamp === null ? null : Number(period.stoppedAtTimestamp) * 1000,
          flowRateWeiPerSecond: BigInt(period.flowRate)
        }));
        const rawUserData = stream.flowUpdatedEvents[0]?.userData;
        const buyerAddress = decodeBuyerFromUserData(rawUserData);
        return {
          account: stream.sender.id.toLowerCase(),
          flowRateWeiPerSecond,
          lastUpdateAt,
          periods,
          buyerAddress
        };
      });

      streams.push(...batch);
      pages += 1;

      if (batch.length < pageSize) break;
      skip += pageSize;
    }
  } catch (error) {
    const message = errorMessage(error);
    logError("superfluid.streams.fetch.failed", {
      endpoint,
      receiver: redactAddress(receiver),
      token: redactAddress(token),
      senderFilter: redactAddress(senderFilter),
      message
    });
    return [];
  }

  logInfo("superfluid.streams.fetch.end", {
    endpoint,
    senderFilter: redactAddress(senderFilter),
    pages,
    count: streams.length
  });

  return streams;
}
