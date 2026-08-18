import { ethers } from "ethers";

const OPERATOR_ABI = [
  "event BuyerDepositFunded(address indexed buyer,uint256 principal,uint256 bonus)",
  "event BuyerDepositFundedWithId(address indexed buyer,uint256 principal,uint256 bonus,string id)",
  "function buyerAccountingMigrated(address buyer) view returns (bool)",
  "function migrateBuyerAccounting(address[] buyers) external"
] as const;

type BlockRange = {
  fromBlock: number;
  toBlock: number;
};
const rpcUrl = "https://mainnet.base.org";
const provider = new ethers.JsonRpcProvider(rpcUrl);
const operatorAddress = "0x192288D921045aa96903e5286E116960e5fb4607";
const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const runner = new ethers.Wallet(process.env.OPERATOR_OWNER_PRIVATE_KEY as string, provider);
const operator = new ethers.Contract(operatorAddress, OPERATOR_ABI, runner);
const eventInterface = new ethers.Interface(OPERATOR_ABI);

const main = async () => {
  const toBlock = await resolveToBlock();
  const fromBlock = 48055111;
  const batchSize = optionalNumberEnv("BATCH_SIZE", 100);

  // new ethers.Wallet(mustAny(["DEPLOYER_PRIVATE_KEY", "OPERATOR_OWNER_PRIVATE_KEY", "ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY"]), provider);

  if (fromBlock > toBlock) {
    throw new Error(`FROM_BLOCK (${fromBlock}) must be <= TO_BLOCK (${toBlock})`);
  }

  console.log(`Scanning ${operatorAddress} deposit events from block ${fromBlock} to ${toBlock}`);

  const buyers = await collectHistoricalBuyers({ fromBlock, toBlock });
  console.log(`Found ${buyers.length} unique buyer(s) in deposit events`);

  const unmigratedBuyers = await filterUnmigratedBuyers(buyers);
  console.log(`${unmigratedBuyers.length} buyer(s) still need accounting migration`);

  if (dryRun) {
    for (const buyer of unmigratedBuyers) console.log(buyer);
    process.exit(0);
  }

  for (let index = 0; index < unmigratedBuyers.length; index += batchSize) {
    const batch = unmigratedBuyers.slice(index, index + batchSize);
    console.log(`Migrating batch ${index / batchSize + 1}: ${batch.length} buyer(s)`);
    const tx = await operator["migrateBuyerAccounting(address[])"](batch);
    console.log(`  sent ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  confirmed in block ${receipt?.blockNumber}`);
  }

  console.log("Buyer accounting migration complete");
};

async function collectHistoricalBuyers(range: BlockRange): Promise<string[]> {
  const logChunkSize = optionalNumberEnv("LOG_CHUNK_SIZE", 10_000);
  const buyers = new Map<string, string>();
  const depositTopics = [ethers.id("BuyerDepositFunded(address,uint256,uint256)"), ethers.id("BuyerDepositFundedWithId(address,uint256,uint256,string)")];

  for (const topic of depositTopics) {
    for (let start = range.fromBlock; start <= range.toBlock; start += logChunkSize) {
      console.log(`Querying logs for topic ${topic} from block ${start} to ${Math.min(start + logChunkSize - 1, range.toBlock)}`);
      const end = Math.min(start + logChunkSize - 1, range.toBlock);
      const logs = await provider.getLogs({
        address: operatorAddress,
        fromBlock: start,
        toBlock: end,
        topics: [topic]
      });

      for (const log of logs) {
        const parsed = eventInterface.parseLog(log);
        if (!parsed) continue;
        const buyer = ethers.getAddress(parsed.args.buyer as string);
        buyers.set(buyer.toLowerCase(), buyer);
      }

      if (logs.length > 0) {
        console.log(`  blocks ${start}-${end}: ${logs.length} deposit event(s)`);
      }
    }
  }

  return [...buyers.values()].sort((left, right) => left.localeCompare(right));
}

async function filterUnmigratedBuyers(buyers: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const buyer of buyers) {
    if (!(await operator.buyerAccountingMigrated(buyer))) {
      result.push(buyer);
    }
  }
  return result;
}

async function resolveToBlock(): Promise<number> {
  const raw = process.env.TO_BLOCK;
  if (!raw || raw === "latest") return provider.getBlockNumber();
  return parseBlockNumber(raw, "TO_BLOCK");
}

function optionalNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  return parseBlockNumber(value, name);
}

function parseBlockNumber(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer block number`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is outside JavaScript safe integer range`);
  return parsed;
}

function printUsage(): void {
  console.log(`Usage:
  BASE_RPC_URL=https://mainnet.base.org \\
  ANTSEED_BUYER_OPERATOR_ADDRESS=0x... \\
  FROM_BLOCK=<operator-deploy-block> \\
  yarn migrate:buyer-accounting

Required for sending migration transactions:
  DEPLOYER_PRIVATE_KEY=0x...     Owner/admin key for AntseedBuyerOperator

Options:
  TO_BLOCK=latest|<block>       Defaults to latest
  DRY_RUN=1                     Print unmigrated buyers without requiring a private key
  BATCH_SIZE=<count>            Defaults to 100 buyers per transaction
  LOG_CHUNK_SIZE=<blocks>       Defaults to 50000 blocks per log query

Address fallback:
  If ANTSEED_BUYER_OPERATOR_ADDRESS is omitted, deploy-base-output.json at the repository root is used.
`);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printUsage();
  process.exit(0);
} else {
  main();
}
