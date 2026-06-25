import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { encodeVaultEventLog, fetchCurrentGdMicroUsdPerToken, fetchGoodIdRoot, parseCeloVaultLogs, decodeBuyerFromUserData } from "../src/celo-events.js";

const vault = "0x0000000000000000000000000000000000000abc";
const account = "0x0000000000000000000000000000000000000def";
const txHash = "0x" + "11".repeat(32);

test("parses verified Celo vault GdDeposited logs into credit principal", () => {
  const buyer = "0x0000000000000000000000000000000000000aaa";
  const log = encodeVaultEventLog("GdDeposited", [account, buyer, 2_000_000_000_000_000_000n, "0x1234"], vault, txHash, 7);
  const events = parseCeloVaultLogs([log], vault);

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "deposit");
  if (events[0].kind === "deposit") {
    assert.equal(events[0].account.toLowerCase(), account.toLowerCase());
    assert.equal(events[0].buyer.toLowerCase(), buyer.toLowerCase());
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
  const buyer = "0x0000000000000000000000000000000000000bbb";
  const flowRate = 38580246913580n;
  const monthly = flowRate * BigInt(30 * 24 * 60 * 60);
  const totalFlow = flowRate * 3600n;
  const log = encodeVaultEventLog("StreamUpdated", [account, buyer, flowRate, monthly, totalFlow], vault, txHash, 2);
  const events = parseCeloVaultLogs([log], vault);

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "stream");
  if (events[0].kind === "stream") {
    assert.equal(events[0].buyer.toLowerCase(), buyer.toLowerCase());
    assert.equal(events[0].flowRateWeiPerSecond, flowRate);
    assert.equal(events[0].monthlyGdAmountWei, monthly);
    assert.equal(events[0].totalFlowWei, totalFlow);
  }
});

test("decodeBuyerFromUserData decodes abi-encoded address from Superfluid userData", () => {
  const buyer = "0x000000000000000000000000000000000000bEEF";
  // Simulate abi.encode(address): 12 bytes padding + 20 bytes address = 32 bytes
  const encoded = "0x" + "00".repeat(12) + buyer.slice(2).toLowerCase();
  const decoded = decodeBuyerFromUserData(encoded);
  assert.equal(decoded, buyer.toLowerCase());

  assert.equal(decodeBuyerFromUserData(undefined), undefined);
  assert.equal(decodeBuyerFromUserData("0x"), undefined);
  assert.equal(decodeBuyerFromUserData("0x" + "00".repeat(32)), undefined); // zero address
});

test("fetches GD price from reserve currentPrice", async () => {
  const exchangeId = "0xba77f5c7bb3317643c6d81d1ef3f9913561741d92095f88efa402faf2cbe9124";
  const reserveAbi = new Interface(["function currentPrice(bytes32 exchangeId) view returns (uint256)"]);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.method, "eth_call");
    const callData = String(body.params[0].data);
    const expectedSelector = reserveAbi.encodeFunctionData("currentPrice", [exchangeId]).slice(0, 10);
    assert.equal(callData.slice(0, 10), expectedSelector);
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: reserveAbi.encodeFunctionResult("currentPrice", [500_000n])
    });
  }) as typeof fetch;

  try {
    const price = await fetchCurrentGdMicroUsdPerToken({
      GD_MICRO_USD_PER_TOKEN: 1_000_000n,
      CELO_RPC_URL: "https://celo.example",
      CELO_RESERVE_PRICE_ORACLE_ADDRESS: "0x0000000000000000000000000000000000000abc",
      CELO_RESERVE_EXCHANGE_ID: exchangeId,
      MAX_BONUS_CAP_MICRO_USD: 100_000_000n
    });
    assert.equal(price, 500_000n);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
