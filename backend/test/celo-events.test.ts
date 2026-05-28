import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { encodeVaultEventLog, fetchCurrentGdMicroUsdPerToken, fetchGoodIdRoot, parseCeloVaultLogs } from "../src/celo-events.js";

const vault = "0x0000000000000000000000000000000000000abc";
const account = "0x0000000000000000000000000000000000000def";
const txHash = "0x" + "11".repeat(32);

test("parses verified Celo vault GdDeposited logs into credit principal", () => {
  const log = encodeVaultEventLog("GdDeposited", [account, account, 2_000_000_000_000_000_000n, "0x1234"], vault, txHash, 7);
  const events = parseCeloVaultLogs([log], vault);

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "deposit");
  if (events[0].kind === "deposit") {
    assert.equal(events[0].account.toLowerCase(), account.toLowerCase());
    assert.equal(events[0].gdAmountWei, 2_000_000_000_000_000_000n);
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
      GD_MICRO_USD_PER_TOKEN: 1_000_000n,
      CELO_RPC_URL: "https://celo.example",
      CELO_GOODID_ADDRESS: "0x0000000000000000000000000000000000000abc",
      MAX_BONUS_CAP_MICRO_USD: 100_000_000n
    });
    assert.equal(fetchedRoot, root);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("parses Celo vault StreamUpdated logs", () => {
  const flowRate = 38580246913580n;
  const monthly = flowRate * BigInt(30 * 24 * 60 * 60);
  const totalFlow = flowRate * 3600n;
  const log = encodeVaultEventLog("StreamUpdated", [account, flowRate, monthly, totalFlow], vault, txHash, 2);
  const events = parseCeloVaultLogs([log], vault);

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "stream");
  if (events[0].kind === "stream") {
    assert.equal(events[0].flowRateWeiPerSecond, flowRate);
    assert.equal(events[0].monthlyGdAmountWei, monthly);
    assert.equal(events[0].totalFlowWei, totalFlow);
  }
});

test("fetches GD price from reserve currentPriceCDAI", async () => {
  const reserveAbi = new Interface(["function currentPriceCDAI() view returns (uint256)"]);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.method, "eth_call");
    const callData = String(body.params[0].data);
    const expectedSelector = reserveAbi.encodeFunctionData("currentPriceCDAI", []).slice(0, 10);
    assert.equal(callData.slice(0, 10), expectedSelector);
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: reserveAbi.encodeFunctionResult("currentPriceCDAI", [500000000000000000n])
    });
  }) as typeof fetch;

  try {
    const price = await fetchCurrentGdMicroUsdPerToken({
      GD_MICRO_USD_PER_TOKEN: 1_000_000n,
      CELO_RPC_URL: "https://celo.example",
      CELO_RESERVE_PRICE_ORACLE_ADDRESS: "0x0000000000000000000000000000000000000abc",
      MAX_BONUS_CAP_MICRO_USD: 100_000_000n
    });
    assert.equal(price, 500000n);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
