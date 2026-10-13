import { Env } from "./env.js";
import { errorMessage, logWarn } from "./logging.js";

export async function parseJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error("content-type must be application/json");
  return request.json();
}

export async function notifySlackOnRequestError(env: Env, details: { method: string; path: string; body: string | undefined; message: string }): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) return;

  try {
    const text = [
      "Worker request exception",
      `method: ${details.method}`,
      `path: ${details.path}`,
      `body: ${formatSlackBody(details.body)}`,
      `error: ${details.message}`
    ].join("\n");

    const response = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      logWarn("slack.notify.failed", {
        status: response.status,
        path: details.path
      });
    }
  } catch (error) {
    logWarn("slack.notify.error", {
      path: details.path,
      message: errorMessage(error)
    });
  }
}

export async function readRequestBody(request: Pick<Request, "text">): Promise<string | undefined> {
  try {
    const body = await request.text();
    if (!body) return undefined;
    return truncate(body, 3000);
  } catch (error) {
    return `[unavailable: ${errorMessage(error)}]`;
  }
}

function formatSlackBody(body: string | undefined): string {
  if (body === undefined) return "[empty]";
  return body;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}... [truncated]`;
}

export function json(body: unknown, status = 200): Response {
  return cors(Response.json(body, { status }));
}

export function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,authorization,x-api-key,x-gooddollar-account");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * Credit every account streaming into the vault for the G$ its stream periods carried since its last
 * credit, and sync each account's recorded flow rate. The only path that credits streams.
 *
 * Each account is owed `streamOwedWei(periods, lastStreamCreditAt, asOf)`: every constant-rate period
 * times its overlap with the uncredited window. That prices rate changes, closes and re-opens exactly,
 * with no remembered rate or stream "last update" to go stale. `asOf` is the subgraph's indexed head,
 * not wall-clock time, so the window never runs past what the subgraph has seen.
 *
 * The deposit id is the window's start (`stream:<account>:<creditedThrough>`). Two runs that overlap
 * read the same clock, derive the same id and are funded once: `depositForWithId` dedupes on it.
 *
 * Live streams are gated by a 24h cooldown and `MIN_STREAM_BONUS_WEI`. An account whose streams have
 * all closed is settled in full regardless, so its final tail is paid out and the closed-periods
 * cursor can move past it.
 */
