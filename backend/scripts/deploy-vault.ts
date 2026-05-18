import { readFile } from "node:fs/promises";
import { ethers } from "ethers";

const rpcUrl = must("RPC_URL");
const privateKey = must("DEPLOYER_PRIVATE_KEY");
const token = must("CREDIT_TOKEN_ADDRESS");
const treasury = must("TREASURY_ADDRESS");
const artifactPath = process.env.VAULT_ARTIFACT ?? "../contracts/out/AgentCreditVault.sol/AgentCreditVault.json";

const provider = new ethers.JsonRpcProvider(rpcUrl);
const signer = new ethers.Wallet(privateKey, provider);
const artifact = JSON.parse(await readFile(new URL(artifactPath, import.meta.url), "utf8"));
const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object ?? artifact.bytecode, signer);
const contract = await factory.deploy(token, treasury);
await contract.waitForDeployment();
console.log(`AgentCreditVault deployed: ${await contract.getAddress()}`);

function must(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
