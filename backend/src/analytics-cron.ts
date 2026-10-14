import { Env } from "./env.js";
import { runAnalyticsAggregation } from "./analytics.js";

export const ANALYTICS_REFRESH_COOLDOWN_MS = 60 * 60 * 1000;
export const ANALYTICS_REFRESH_LAST_RUN_KEY = "analytics:refresh:last-run-at";
export const ANALYTICS_CRON_BACKFILL_DAYS = 40;
const ANALYTICS_CRON_BACKFILL_CURSOR_KEY = "analytics:cron:backfill-cursor";

export async function backFillAnalytics(env: Env, maxRunsPerTick = 2) {
  const kv = env.ANTSEED_KV;
  const summaries: Array<{ currentDate: string; finalizedDates: string[] }> = [];
  const runAt = new Date();
  const todayDate = runAt.toISOString().slice(0, 10);
  let cursorDate = await readAnalyticsBackfillCursorDate(env.ANTSEED_KV);
  if (!cursorDate) {
    cursorDate = dateDaysAgo(runAt, ANALYTICS_CRON_BACKFILL_DAYS);
    await kv.put(ANALYTICS_CRON_BACKFILL_CURSOR_KEY, cursorDate);
  }
  // TODO: replace bounded loop with persisted backfill cursor when we need broader historical catch-up.
  for (let i = 0; i < maxRunsPerTick; i += 1) {
    console.log(`analytics backfill run ${i + 1} of ${maxRunsPerTick}, cursorDate=${cursorDate}`);
    const aggregationRunAt = cursorDate === todayDate ? runAt : new Date(`${cursorDate}T23:59:59.999Z`);
    const analyticsSummary = await runAnalyticsAggregation(env, aggregationRunAt);
    console.log(`analytics backfill run ${i + 1} of ${maxRunsPerTick}, cursorDate=${cursorDate} completed`, analyticsSummary);
    summaries.push({
      currentDate: analyticsSummary.currentDate,
      finalizedDates: analyticsSummary.finalizedDates
    });
    if (cursorDate === todayDate) {
      break;
    }
    const nextCursorDate = nextUtcDate(cursorDate);
    cursorDate = nextCursorDate && nextCursorDate <= todayDate ? nextCursorDate : todayDate;
    await kv.put(ANALYTICS_CRON_BACKFILL_CURSOR_KEY, cursorDate);
  }
  return summaries;
}

export async function readAnalyticsRefreshTimestamp(kv: Pick<KVNamespace, "get">): Promise<number | undefined> {
  const raw = await kv.get(ANALYTICS_REFRESH_LAST_RUN_KEY);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export async function readAnalyticsBackfillCursorDate(kv: Pick<KVNamespace, "get">): Promise<string | undefined> {
  const raw = await kv.get(ANALYTICS_CRON_BACKFILL_CURSOR_KEY);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  return raw;
}

function dateDaysAgo(date: Date, days: number): string {
  const shifted = new Date(date.getTime());
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return shifted.toISOString().slice(0, 10);
}

function nextUtcDate(date: string): string | undefined {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}
