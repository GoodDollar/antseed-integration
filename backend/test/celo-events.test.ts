import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { encodeVaultEventLog, fetchGoodIdRoot, parseCeloVaultLogs } from "../src/celo-events.js";

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

test("fetches GoodID root with eth_call for root aggregation", async () => {
  const goodId = new Interface(["function getWhitelistedRoot(address) view returns (address)"]);
  const root = "0x0000000000000000000000000000000000000aaa";
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.method, "eth_call");
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: goodId.encodeFunctionResult("getWhitelistedRoot", [root])
    });
  }) as typeof fetch;

  try {
    const fetchedRoot = await fetchGoodIdRoot(account, {
      ANTSEED_BASE_URL: "http://localhost",
      ANTSEED_MODEL: "test",
      ANTSEED_TIMEOUT_MS: 1000,
      ANTSEED_MIN_BUYER_DEPOSIT_MICRO_USD: 1n,
      PRICE_MICRO_USD_PER_1K_INPUT_TOKENS: 1n,
      PRICE_MICRO_USD_PER_1K_OUTPUT_TOKENS: 1n,
      DEFAULT_MAX_OUTPUT_TOKENS: 1,
      MIN_RESERVE_MICRO_USD: 1n,
      CREDIT_TOKEN_DECIMALS: 6,
      GD_MICRO_USD_PER_TOKEN: 1_000_000n,
      AUTH_NONCE_TTL_SECONDS: 600,
      ALLOW_UNVERIFIED_ACCOUNT_SELECTOR: false,
      CELO_RPC_URL: "https://celo.example",
      CELO_GOODID_ADDRESS: "0x0000000000000000000000000000000000000abc"
    });
    assert.equal(fetchedRoot, root);
  } finally {
    globalThis.fetch = previousFetch;
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
