import {
  signSetOperator,
  makeDepositsDomain,
  SET_OPERATOR_TYPES,
} from '@antseed/node/payments';
import { ethers } from 'ethers';
// also exported from '@antseed/node'

const chainId = 8453;
const domain = makeDepositsDomain(chainId, "0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2");
//generate ethers signer for buyer
let wallet = new ethers.Wallet(process.argv[2]);
//connect to base rpc provider
wallet = wallet.connect(new ethers.JsonRpcProvider("https://base.drpc.org"));
const operator = "0x192288D921045aa96903e5286E116960e5fb4607"
const nonce = 0n;
const buyerSig = await signSetOperator(wallet, domain, {
  operator,
  nonce,
});

console.log("buyerSig", buyerSig);

