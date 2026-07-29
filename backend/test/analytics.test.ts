import test from "node:test";
import assert from "node:assert/strict";
import { getAnalyticsWindow, resolveRunDate, runAnalyticsAggregation } from "../src/analytics.js";
import { Env } from "../src/env.js";

class MemoryKV {
  private data = new Map<string, string>();

  async get(key: string, type?: "text" | "json") {
    const raw = this.data.get(key) ?? null;
    if (type === "json") return raw ? JSON.parse(raw) : null;
    return raw;
  }

  async put(key: string, value: string) {
    this.data.set(key, value);
  }
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    ANTSEED_KV: new MemoryKV() as never,
    ...overrides
  } as Env;
}

test("resolveRunDate advances to finalizedThroughDate + 1 when still behind today", () => {
  const state = {
    updatedAt: "2026-07-24T00:00:00.000Z",
    finalizedThroughDate: "2026-07-22"
  };

  const runDate = resolveRunDate(state, new Date("2026-07-24T10:00:00.000Z"), "2026-07-24");
  assert.equal(runDate, "2026-07-23");
});

test("resolveRunDate uses requested day when already caught up", () => {
  const state = {
    updatedAt: "2026-07-24T00:00:00.000Z",
    finalizedThroughDate: "2026-07-23"
  };

  const runDate = resolveRunDate(state, new Date("2026-07-24T10:00:00.000Z"), "2026-07-24");
  assert.equal(runDate, "2026-07-24");
});

test("resolveRunDate clamps future requested dates to today", () => {
  const state = {
    updatedAt: "2026-07-24T00:00:00.000Z"
  };

  const runDate = resolveRunDate(state, new Date("2026-07-30T10:00:00.000Z"), "2026-07-24");
  assert.equal(runDate, "2026-07-24");
});

test("resolveRunDate prefers cursor day over requested older date", () => {
  const state = {
    updatedAt: "2026-07-24T00:00:00.000Z",
    finalizedThroughDate: "2026-07-22"
  };

  const runDate = resolveRunDate(state, new Date("2026-07-20T10:00:00.000Z"), "2026-07-24");
  assert.equal(runDate, "2026-07-23");
});

test("runAnalyticsAggregation calculates streamed G$ across a mid-day flow update", { concurrency: false }, async () => {
  const testEnv = env({
    CELO_VAULT_ADDRESS: "0x4Dd0136b9aabD5823cf0F65d89e8fB882C660885",
    CELO_GD_SUPERTOKEN_ADDRESS: "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A",
    CELO_BLOCKSCOUT_API_URL: "https://celo.blockscout.test/api",
    BASE_BLOCKSCOUT_API_URL: "https://base.blockscout.test/api",
    ANTSEED_CHANNELS_ADDRESS: "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d",
    SUPERFLUID_SUBGRAPH_URL: "https://superfluid.test/subgraph"
  });

  const now = new Date("2026-07-24T12:00:00.000Z");
  const dayStartUnix = Math.floor(new Date("2026-07-24T00:00:00.000Z").getTime() / 1000);
  const updatedAtTimestamp = dayStartUnix + 6 * 60 * 60;
  const expectedStreamed = (2n * BigInt(6 * 60 * 60) + 4n * BigInt(6 * 60 * 60)).toString();

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = typeof urlInput === "string" ? new URL(urlInput) : urlInput instanceof URL ? urlInput : new URL(urlInput.url);

      if (url.host === "celo.blockscout.test") {
        if (url.searchParams.get("action") === "getblocknobytime") {
          return Response.json({ status: "1", message: "OK", result: "100" });
        }
        if (url.searchParams.get("action") === "getLogs") {
          return Response.json({ status: "0", message: "No records found", result: "No records found" });
        }
      }

      if (url.host === "base.blockscout.test") {
        if (url.searchParams.get("action") === "getblocknobytime") {
          return Response.json({ status: "1", message: "OK", result: "200" });
        }
        if (url.searchParams.get("action") === "getLogs") {
          return Response.json({ status: "0", message: "No records found", result: "No records found" });
        }
      }

      if (url.host === "superfluid.test") {
        const body = JSON.parse(String(init?.body)) as { variables: { skip: number } };
        if (body.variables.skip > 0) {
          return Response.json({ data: { streams: [] } });
        }
        return Response.json({
          data: {
            streams: [
              {
                sender: { id: "0x0000000000000000000000000000000000000abc" },
                currentFlowRate: "4",
                updatedAtTimestamp: String(updatedAtTimestamp),
                flowUpdatedEvents: [{ userData: "0x", oldFlowRate: "2" }]
              }
            ]
          }
        });
      }

      throw new Error(`unexpected fetch url: ${url.toString()}`);
    }) as typeof fetch;

    await runAnalyticsAggregation(testEnv, now);
    const analytics = await getAnalyticsWindow(testEnv, 1, now);
    assert.equal(analytics.daily[0].gdStreamedWei, expectedStreamed);
    assert.equal(analytics.global.gdStreamedWei, expectedStreamed);
    assert.equal(analytics.daily[0].uniqueGdBuyers, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runAnalyticsAggregation calculates streamed G$ for streams active since before day start", { concurrency: false }, async () => {
  const testEnv = env({
    CELO_VAULT_ADDRESS: "0x4Dd0136b9aabD5823cf0F65d89e8fB882C660885",
    CELO_GD_SUPERTOKEN_ADDRESS: "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A",
    CELO_BLOCKSCOUT_API_URL: "https://celo.blockscout.test/api",
    BASE_BLOCKSCOUT_API_URL: "https://base.blockscout.test/api",
    ANTSEED_CHANNELS_ADDRESS: "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d",
    SUPERFLUID_SUBGRAPH_URL: "https://superfluid.test/subgraph"
  });

  const now = new Date("2026-07-24T12:00:00.000Z");
  const dayStartUnix = Math.floor(new Date("2026-07-24T00:00:00.000Z").getTime() / 1000);
  const updatedAtTimestamp = dayStartUnix - 2 * 60 * 60;
  const expectedStreamed = (3n * BigInt(12 * 60 * 60)).toString();

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = typeof urlInput === "string" ? new URL(urlInput) : urlInput instanceof URL ? urlInput : new URL(urlInput.url);

      if (url.host === "celo.blockscout.test") {
        if (url.searchParams.get("action") === "getblocknobytime") {
          return Response.json({ status: "1", message: "OK", result: "100" });
        }
        if (url.searchParams.get("action") === "getLogs") {
          return Response.json({ status: "0", message: "No records found", result: "No records found" });
        }
      }

      if (url.host === "base.blockscout.test") {
        if (url.searchParams.get("action") === "getblocknobytime") {
          return Response.json({ status: "1", message: "OK", result: "200" });
        }
        if (url.searchParams.get("action") === "getLogs") {
          return Response.json({ status: "0", message: "No records found", result: "No records found" });
        }
      }

      if (url.host === "superfluid.test") {
        const body = JSON.parse(String(init?.body)) as { variables: { skip: number } };
        if (body.variables.skip > 0) {
          return Response.json({ data: { streams: [] } });
        }
        return Response.json({
          data: {
            streams: [
              {
                sender: { id: "0x0000000000000000000000000000000000000abc" },
                currentFlowRate: "3",
                updatedAtTimestamp: String(updatedAtTimestamp),
                flowUpdatedEvents: [{ userData: "0x" }]
              }
            ]
          }
        });
      }

      throw new Error(`unexpected fetch url: ${url.toString()}`);
    }) as typeof fetch;

    await runAnalyticsAggregation(testEnv, now);
    const analytics = await getAnalyticsWindow(testEnv, 1, now);
    assert.equal(analytics.daily[0].gdStreamedWei, expectedStreamed);
    assert.equal(analytics.global.gdStreamedWei, expectedStreamed);
    assert.equal(analytics.daily[0].uniqueGdBuyers, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
