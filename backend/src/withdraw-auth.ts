import { verifyTypedData } from "ethers";
import { Eip712SigningPayload } from "./operator-auth.js";

export const WITHDRAW_SIGNATURE_MAX_AGE_SECONDS = 300;

export function withdrawPrincipalDomain(chainId: number, verifyingContract: string) {
  return {
    name: "AntseedBuyerOperator",
    version: "1",
    chainId,
    verifyingContract
  };
}

export const WITHDRAW_PRINCIPAL_TYPES = {
  WithdrawPrincipal: [
    { name: "buyer", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "timestamp", type: "uint256" }
  ]
};

export function assertWithdrawTimestampFresh(timestamp: number, nowSeconds = Math.floor(Date.now() / 1000)): void {
  if (timestamp > nowSeconds) {
    throw new Error("withdraw signature timestamp is in the future");
  }
  if (nowSeconds - timestamp > WITHDRAW_SIGNATURE_MAX_AGE_SECONDS) {
    throw new Error("withdraw signature expired");
  }
}

export function recoverWithdrawPrincipalSigner(
  chainId: number,
  verifyingContract: string,
  buyer: string,
  amountMicroUsd: bigint,
  recipient: string,
  timestamp: bigint,
  buyerSig: string
): string {
  return verifyTypedData(
    withdrawPrincipalDomain(chainId, verifyingContract),
    WITHDRAW_PRINCIPAL_TYPES,
    {
      buyer,
      amount: amountMicroUsd,
      recipient,
      timestamp
    },
    buyerSig
  );
}

export function buildWithdrawPrincipalPayload(
  chainId: number,
  verifyingContract: string,
  buyer: string,
  amountMicroUsd: bigint,
  recipient: string,
  timestamp: number
): Eip712SigningPayload {
  return {
    primaryType: "WithdrawPrincipal",
    domain: {
      name: "AntseedBuyerOperator",
      version: "1",
      chainId,
      verifyingContract: verifyingContract.toLowerCase()
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" }
      ],
      ...WITHDRAW_PRINCIPAL_TYPES
    },
    message: {
      buyer: buyer.toLowerCase(),
      amount: amountMicroUsd.toString(),
      recipient: recipient.toLowerCase(),
      timestamp
    }
  };
}
