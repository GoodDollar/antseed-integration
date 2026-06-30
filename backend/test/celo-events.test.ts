import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { encodeVaultEventLog, fetchCurrentGdPrice, fetchGoodIdRoot, parseCeloVaultLogs, decodeBuyerFromUserData } from "../src/celo-events.js";

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
      GD_CUSD_PRICE: 1.0,
      CELO_RPC_URL: "https://celo.example",
      CELO_GOODID_ADDRESS: "0x0000000000000000000000000000000000000abc",
      MAX_BONUS_CAP_USD: 100_000_000n
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

test("fetches GD price from StaticOracle quoteAllAvailablePoolsWithTimePeriod", async () => {
  const oracleAbi = new Interface([
    "function quoteAllAvailablePoolsWithTimePeriod(uint128 baseAmount, address baseToken, address quoteToken, uint32 period) view returns (uint256 quoteAmount, address[] queriedPools)"
  ]);
  const gdToken = "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A";
  const previousFetch = globalThis.fetch;
  // oracle returns 1154299954649337 cUSD wei for 1 G$ ≈ 0.001154 cUSD
  const quoteWei = 1154299954649337n;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.method, "eth_call");
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: oracleAbi.encodeFunctionResult("quoteAllAvailablePoolsWithTimePeriod", [quoteWei, []])
    });
  }) as typeof fetch;

  try {
    const price = await fetchCurrentGdPrice({
      GD_CUSD_PRICE: 0.001,
      CELO_RPC_URL: "https://celo.example",
      CELO_GD_SUPERTOKEN_ADDRESS: gdToken,
      MAX_BONUS_CAP_USD: 100_000_000n
    });
    // 1154299954649337 / 1e18 ≈ 0.001154299...
    assert.ok(price > 0.001154 && price < 0.001155, `expected ~0.001154 but got ${price}`);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
