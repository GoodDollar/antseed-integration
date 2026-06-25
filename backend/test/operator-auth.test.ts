import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, verifyTypedData } from "ethers";
import {
  buildSetOperatorPayload,
  recoverSetOperatorSigner,
  SET_OPERATOR_TYPES
} from "../src/operator-auth.js";

test("buildSetOperatorPayload matches wallet signTypedData", async () => {
  const wallet = Wallet.createRandom();
  const chainId = 8453;
  const depositsAddress = "0x00000000000000000000000000000000000000aa";
  const operatorAddress = "0x0000000000000000000000000000000000000bbb";
  const nonce = 7n;
  const domain = { name: "AntseedDeposits", version: "1" };

  const payload = buildSetOperatorPayload(chainId, depositsAddress, operatorAddress, nonce, domain);
  const sig = await wallet.signTypedData(payload.domain, SET_OPERATOR_TYPES, {
    operator: operatorAddress,
    nonce
  });

  const recovered = recoverSetOperatorSigner(
    chainId,
    depositsAddress,
    operatorAddress,
    nonce,
    sig,
    domain
  );

  assert.equal(recovered.toLowerCase(), wallet.address.toLowerCase());
  assert.equal(
    verifyTypedData(payload.domain, SET_OPERATOR_TYPES, { operator: operatorAddress, nonce }, sig).toLowerCase(),
    wallet.address.toLowerCase()
  );
});
