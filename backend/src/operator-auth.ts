import { verifyTypedData } from "ethers";

export type Eip712SigningPayload = {
  primaryType: string;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  message: Record<string, string | number>;
};

export const SET_OPERATOR_TYPES = {
  SetOperator: [
    { name: "operator", type: "address" },
    { name: "nonce", type: "uint256" }
  ]
};

export function buildSetOperatorPayload(
  chainId: number,
  depositsAddress: string,
  operatorAddress: string,
  nonce: bigint,
  domain: { name: string; version: string }
): Eip712SigningPayload {
  return {
    primaryType: "SetOperator",
    domain: {
      name: domain.name,
      version: domain.version,
      chainId,
      verifyingContract: depositsAddress.toLowerCase()
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" }
      ],
      ...SET_OPERATOR_TYPES
    },
    message: {
      operator: operatorAddress.toLowerCase(),
      nonce: nonce.toString()
    }
  };
}

export function recoverSetOperatorSigner(
  chainId: number,
  depositsAddress: string,
  operatorAddress: string,
  nonce: bigint,
  buyerSig: string,
  domain: { name: string; version: string }
): string {
  return verifyTypedData(
    {
      name: domain.name,
      version: domain.version,
      chainId,
      verifyingContract: depositsAddress
    },
    SET_OPERATOR_TYPES,
    {
      operator: operatorAddress,
      nonce
    },
    buyerSig
  );
}
