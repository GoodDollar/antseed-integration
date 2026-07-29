import test from "node:test";
import assert from "node:assert/strict";
import { resolveRunDate } from "../src/analytics.js";

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
