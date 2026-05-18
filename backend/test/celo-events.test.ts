import test from "node:test";
import assert from "node:assert/strict";
import { encodeVaultEventLog, parseCeloVaultLogs } from "../src/celo-events.js";

const vault = "0x0000000000000000000000000000000000000abc";
const account = "0x0000000000000000000000000000000000000def";
const txHash = "0x" + "11".repeat(32);

test("parses verified Celo vault GdDeposited logs into credit principal", () => {
  const log = encodeVaultEventLog("GdDeposited", [account, account, 2_000_000_000_000_000_000n, "0x1234"], vault, txHash, 7);
  const events = parseCeloVaultLogs([log], vault, 1_000_000n);

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "deposit");
  if (events[0].kind === "deposit") {
    assert.equal(events[0].account.toLowerCase(), account.toLowerCase());
    assert.equal(events[0].gdAmountWei, 2_000_000_000_000_000_000n);
    assert.equal(events[0].principalMicroUsd, 2_000_000n);
    assert.equal(events[0].logIndex, 7);
  }
});

test("parses Celo vault StreamUpdated logs", () => {
  const flowRate = 38580246913580n;
  const monthly = flowRate * BigInt(30 * 24 * 60 * 60);
  const log = encodeVaultEventLog("StreamUpdated", [account, flowRate, monthly], vault, txHash, 2);
  const events = parseCeloVaultLogs([log], vault, 1_000_000n);

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "stream");
  if (events[0].kind === "stream") {
    assert.equal(events[0].flowRateWeiPerSecond, flowRate);
    assert.equal(events[0].monthlyGdAmountWei, monthly);
  }
});
