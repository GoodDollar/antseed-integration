import { ethers } from "ethers";
import { RuntimeConfig } from "./env.js";
import { buildSetOperatorPayload } from "./operator-auth.js";
import type { Eip712SigningPayload } from "./operator-auth.js";

const FUNDING_VAULT_ABI = [
  "function registry() view returns (address)",
  "function depositFor(address buyer, uint256 principal, uint256 bonus)",
  "function depositForWithId(address buyer, uint256 principal, uint256 bonus, string id)",
  "function acceptBuyerOperator(address buyer, uint256 nonce, bytes buyerSig)",
  "function withdrawPrincipal(address buyer, uint256 amount, address recipient, uint256 timestamp, bytes buyerSig)",
  "function requestClose(bytes32 channelId, uint256 timestamp, bytes buyerSig)",
  "function withdrawChannel(bytes32 channelId, uint256 timestamp, bytes buyerSig)",
  "function withdrawablePrincipal(address buyer) view returns (uint256)",
  "function usedDepositIds(bytes32 id) view returns (bool)"
] as const;

const REGISTRY_ABI = [
  "function deposits() view returns (address)"
] as const;

const DEPOSITS_ABI = [
  "function getOperator(address buyer) view returns (address)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function operatorNonces(address buyer) view returns (uint256)",
  "function nonces(address buyer) view returns (uint256)"
] as const;

export type AntSeedFundingResult = {
  enabled: boolean;
  buyer: string;
  amountUsd: string;
  txHash?: string;
  error?: string;
};

export type BuyerOperatorStatus = {
  enabled: boolean;
  account: string;
  buyerAddress: string;
  operatorAddress?: string;
  currentOperator: string;
  operatorAccepted: boolean;
  consentNonce: string;
};

export class AntSeedFundingVaultClient {
  readonly enabled: boolean;
  private contract?: ethers.Contract;
  private provider?: ethers.JsonRpcProvider;
  private chainIdPromise?: Promise<number>;
  private depositsAddressPromise?: Promise<string>;
  private depositsDomainPromise?: Promise<{ name: string; version: string }>;

  private toBytes32Id(id: string): string {
    return ethers.id(id);
  }

  constructor(private readonly cfg: RuntimeConfig) {
    this.enabled = Boolean(
      cfg.ANTSEED_FUNDING_RPC_URL &&
      cfg.ANTSEED_FUNDING_VAULT_ADDRESS &&
      cfg.ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY
    );
    if (this.enabled) {
      this.provider = new ethers.JsonRpcProvider(cfg.ANTSEED_FUNDING_RPC_URL);
      const signer = new ethers.Wallet(cfg.ANTSEED_FUNDING_OPERATOR_PRIVATE_KEY!, this.provider);
      this.contract = new ethers.Contract(cfg.ANTSEED_FUNDING_VAULT_ADDRESS!, FUNDING_VAULT_ABI, signer);
    }
  }

  get vaultAddress(): string | undefined {
    return this.cfg.ANTSEED_FUNDING_VAULT_ADDRESS;
  }

  async getChainId(): Promise<number> {
    if (!this.provider) {
      throw new Error("bridge not configured");
    }
    if (!this.chainIdPromise) {
      this.chainIdPromise = this.provider.getNetwork().then((network) => Number(network.chainId));
    }
    return this.chainIdPromise;
  }

  private async getDepositsContract(): Promise<ethers.Contract> {
    if (!this.provider) {
      throw new Error("bridge not configured");
    }
    const depositsAddress = await this.getDepositsAddress();
    return new ethers.Contract(depositsAddress, DEPOSITS_ABI, this.provider);
  }

  async getDepositsAddress(): Promise<string> {
    if (!this.contract) {
      throw new Error("bridge not configured");
    }
    if (!this.depositsAddressPromise) {
      this.depositsAddressPromise = (async () => {
        const registryAddress = await this.contract!.registry();
        const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, this.provider!);
        const depositsAddress = await registry.deposits();
        return String(depositsAddress).toLowerCase();
      })();
    }
    return this.depositsAddressPromise;
  }

  private async getDepositsEip712Domain(): Promise<{ name: string; version: string }> {
    if (!this.depositsDomainPromise) {
      this.depositsDomainPromise = (async () => {
        const deposits = await this.getDepositsContract();
        try {
          const domain = await deposits.eip712Domain();
          return {
            name: String(domain.name),
            version: String(domain.version)
          };
        } catch {
          return { name: "AntseedDeposits", version: "1" };
        }
      })();
    }
    return this.depositsDomainPromise;
  }

  async getOperatorNonce(buyer: string): Promise<bigint> {
    const deposits = await this.getDepositsContract();
    const normalizedBuyer = buyer.toLowerCase();
    try {
      const nonce = await deposits.operatorNonces(normalizedBuyer);
      return BigInt(nonce.toString());
    } catch {
      const nonce = await deposits.nonces(normalizedBuyer);
      return BigInt(nonce.toString());
    }
  }

  async getBuyerOperatorStatus(account: string, buyerAddress?: string): Promise<BuyerOperatorStatus> {
    const buyer = (buyerAddress ?? account).toLowerCase();
    const accountNormalized = account.toLowerCase();
    if (!this.contract || !this.vaultAddress) {
      return {
        enabled: false,
        account: accountNormalized,
        buyerAddress: buyer,
        currentOperator: ethers.ZeroAddress,
        operatorAccepted: false,
        consentNonce: "0"
      };
    }

    const deposits = await this.getDepositsContract();
    const currentOperator = String(await deposits.getOperator(buyer)).toLowerCase();
    const operatorAddress = this.vaultAddress.toLowerCase();
    const consentNonce = await this.getOperatorNonce(buyer);

    return {
      enabled: true,
      account: accountNormalized,
      buyerAddress: buyer,
      operatorAddress,
      currentOperator,
      operatorAccepted: currentOperator === operatorAddress,
      consentNonce: consentNonce.toString()
    };
  }

  async getDepositsSigningDomain(): Promise<{ name: string; version: string }> {
    return this.getDepositsEip712Domain();
  }

  async buildOperatorConsentPayload(account: string, buyerAddress?: string): Promise<{
    enabled: boolean;
    account: string;
    buyerAddress: string;
    typedData?: Eip712SigningPayload;
  }> {
    const status = await this.getBuyerOperatorStatus(account, buyerAddress);
    if (!status.enabled || !status.operatorAddress) {
      return {
        enabled: false,
        account: status.account,
        buyerAddress: status.buyerAddress
      };
    }

    const [chainId, depositsAddress, domain] = await Promise.all([
      this.getChainId(),
      this.getDepositsAddress(),
      this.getDepositsEip712Domain()
    ]);

    return {
      enabled: true,
      account: status.account,
      buyerAddress: status.buyerAddress,
      typedData: buildSetOperatorPayload(
        chainId,
        depositsAddress,
        status.operatorAddress,
        BigInt(status.consentNonce),
        domain
      )
    };
  }

  async acceptBuyerOperator(
    buyer: string,
    nonce: bigint,
    buyerSig: string
  ): Promise<{ enabled: boolean; buyer: string; nonce: string; txHash?: string }> {
    const normalizedBuyer = buyer.toLowerCase();
    if (!this.contract) {
      return { enabled: false, buyer: normalizedBuyer, nonce: nonce.toString() };
    }
    const tx = await this.contract.acceptBuyerOperator(normalizedBuyer, nonce, buyerSig);
    const receipt = await tx.wait();
    return {
      enabled: true,
      buyer: normalizedBuyer,
      nonce: nonce.toString(),
      txHash: receipt?.hash
    };
  }

  async depositForBuyer(buyer: string, principalUsd: bigint, bonusUsd: bigint): Promise<AntSeedFundingResult> {
    const total = principalUsd + bonusUsd;
    if (!this.contract) return { enabled: false, buyer, amountUsd: total.toString() };
    const tx = await this.contract.depositFor(buyer, principalUsd, bonusUsd);
    const receipt = await tx.wait();
    return {
      enabled: true,
      buyer,
      amountUsd: total.toString(),
      txHash: receipt?.hash
    };
  }

  async depositForBuyerWithId(buyer: string, principalUsd: bigint, bonusUsd: bigint, id: string): Promise<AntSeedFundingResult> {
    const total = principalUsd + bonusUsd;
    if (!this.contract) return { enabled: false, buyer, amountUsd: total.toString() };

    const alreadyUsed = await this.contract.usedDepositIds(this.toBytes32Id(id));
    if (alreadyUsed) {
      return { enabled: true, buyer, amountUsd: total.toString() };
    }

    const tx = await this.contract.depositForWithId(buyer, principalUsd, bonusUsd, id);
    const receipt = await tx.wait();
    return {
      enabled: true,
      buyer,
      amountUsd: total.toString(),
      txHash: receipt?.hash
    };
  }

  async getWithdrawablePrincipal(buyer: string): Promise<{ enabled: boolean; buyer: string; withdrawableUsd: string }> {
    const normalizedBuyer = buyer.toLowerCase();
    if (!this.contract) {
      return { enabled: false, buyer: normalizedBuyer, withdrawableUsd: "0" };
    }
    const amount = await this.contract.withdrawablePrincipal(normalizedBuyer);
    return {
      enabled: true,
      buyer: normalizedBuyer,
      withdrawableUsd: amount.toString()
    };
  }

  async withdrawPrincipal(
    buyer: string,
    amountUsd: bigint,
    recipient: string,
    timestamp: bigint,
    buyerSig: string
  ): Promise<{ enabled: boolean; buyer: string; amountUsd: string; recipient: string; txHash?: string }> {
    const normalizedBuyer = buyer.toLowerCase();
    const normalizedRecipient = recipient.toLowerCase();
    if (!this.contract) {
      return {
        enabled: false,
        buyer: normalizedBuyer,
        amountUsd: amountUsd.toString(),
        recipient: normalizedRecipient
      };
    }
    const tx = await this.contract.withdrawPrincipal(
      normalizedBuyer,
      amountUsd,
      normalizedRecipient,
      timestamp,
      buyerSig
    );
    const receipt = await tx.wait();
    return {
      enabled: true,
      buyer: normalizedBuyer,
      amountUsd: amountUsd.toString(),
      recipient: normalizedRecipient,
      txHash: receipt?.hash
    };
  }

  async requestClose(channelId: string, timestamp?: number, buyerSig?: string): Promise<{ enabled: boolean; txHash?: string }> {
    if (!this.contract) return { enabled: false };
    const tx = await this.contract.requestClose(channelId, timestamp ?? 0, buyerSig ?? "0x");
    const receipt = await tx.wait();
    return { enabled: true, txHash: receipt?.hash };
  }

  async withdrawFromChannel(channelId: string, timestamp?: number, buyerSig?: string): Promise<{ enabled: boolean; txHash?: string }> {
    if (!this.contract) return { enabled: false };
    const tx = await this.contract.withdrawChannel(channelId, timestamp ?? 0, buyerSig ?? "0x");
    const receipt = await tx.wait();
    return { enabled: true, txHash: receipt?.hash };
  }
}
