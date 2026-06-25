import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, verifyTypedData } from "ethers";
import {
  assertWithdrawTimestampFresh,
  recoverWithdrawPrincipalSigner,
  withdrawPrincipalDomain,
  WITHDRAW_PRINCIPAL_TYPES,
  WITHDRAW_SIGNATURE_MAX_AGE_SECONDS
} from "../src/withdraw-auth.js";

test("assertWithdrawTimestampFresh rejects expired signatures", () => {
  const now = 1_700_000_000;
  assert.throws(
    () => assertWithdrawTimestampFresh(now - WITHDRAW_SIGNATURE_MAX_AGE_SECONDS - 1, now),
    /expired/
  );
});

test("assertWithdrawTimestampFresh rejects future timestamps", () => {
  const now = 1_700_000_000;
  assert.throws(
    () => assertWithdrawTimestampFresh(now + 1, now),
    /future/
  );
});

test("recoverWithdrawPrincipalSigner matches ethers typed-data signing", async () => {
  const wallet = Wallet.createRandom();
  const chainId = 8453;
  const verifyingContract = "0x00000000000000000000000000000000000000aa";
  const amount = 3_000_000n;
  const recipient = "0x0000000000000000000000000000000000000bbb";
  const timestamp = 1_700_000_000n;
  const buyerSig = await wallet.signTypedData(
    withdrawPrincipalDomain(chainId, verifyingContract),
    WITHDRAW_PRINCIPAL_TYPES,
    {
      buyer: wallet.address,
      amount,
      recipient,
      timestamp
    }
  );

  const recovered = recoverWithdrawPrincipalSigner(
    chainId,
    verifyingContract,
    wallet.address,
    amount,
    recipient,
    timestamp,
    buyerSig
  );

  assert.equal(recovered.toLowerCase(), wallet.address.toLowerCase());
  assert.equal(
    verifyTypedData(
      withdrawPrincipalDomain(chainId, verifyingContract),
      WITHDRAW_PRINCIPAL_TYPES,
      { buyer: wallet.address, amount, recipient, timestamp },
      buyerSig
    ).toLowerCase(),
    wallet.address.toLowerCase()
  );
});
