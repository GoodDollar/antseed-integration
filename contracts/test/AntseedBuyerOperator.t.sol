// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AntseedBuyerOperator, IERC20} from "../src/AntseedBuyerOperator.sol";
import {IAntseedChannels} from "../src/interfaces/IAntseedChannels.sol";
import {IAntseedDeposits} from "../src/interfaces/IAntseedDeposits.sol";
import {IAntseedRegistry} from "../src/interfaces/IAntseedRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface Vm {
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);

    function addr(uint256 privateKey) external pure returns (address);

    function warp(uint256 newTimestamp) external;

    function etch(address target, bytes calldata newRuntimeBytecode) external;
}

/// @dev Minimal ERC-1271 smart wallet that approves digests signed by its owner key.
contract Mock1271Wallet {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecoverCalldata(hash, signature);
        return err == ECDSA.RecoverError.NoError && recovered == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract TestUsdc is IERC20 {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        require(balanceOf[from] >= amount, "BALANCE");
        require(allowance[from][msg.sender] >= amount, "ALLOWANCE");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockDeposits is IAntseedDeposits {
    IERC20 public immutable token;
    mapping(address => address) public operators;
    mapping(address => uint256) public available;
    mapping(address => uint256) public reserved;

    constructor(IERC20 token_) {
        token = token_;
    }

    function usdc() external view override returns (address) {
        return address(token);
    }

    function setOperator(address buyer, address operator, uint256, bytes calldata) external override {
        operators[buyer] = operator;
    }

    function deposit(address buyer, uint256 amount) external override {
        require(token.transferFrom(msg.sender, address(this), amount), "TRANSFER_FROM");
        available[buyer] += amount;
    }

    function withdraw(address buyer, uint256 amount) external override {
        require(available[buyer] >= amount, "INSUFFICIENT");
        available[buyer] -= amount;
        require(token.transfer(msg.sender, amount), "TRANSFER");
    }

    function getBuyerBalance(address buyer) external view override returns (uint256, uint256, uint256) {
        return (available[buyer], reserved[buyer], 0);
    }

    function consume(address buyer, uint256 amount) external {
        require(available[buyer] >= amount, "INSUFFICIENT");
        available[buyer] -= amount;
        require(token.transfer(address(0xD00D), amount), "TRANSFER");
    }

    function reserve(address buyer, uint256 amount) external {
        require(available[buyer] >= amount, "INSUFFICIENT");
        available[buyer] -= amount;
        reserved[buyer] += amount;
    }

    function transferOperator(address buyer, address newOperator) external override {
        operators[buyer] = newOperator;
    }

    function getOperator(address buyer) external view override returns (address) {
        return operators[buyer];
    }
}

contract MockChannels is IAntseedChannels {
    struct Channel {
        address buyer;
        address seller;
        uint128 deposit;
        uint128 settled;
        bytes32 metadataHash;
        uint256 deadline;
        uint256 settledAt;
        uint256 closeRequestedAt;
        uint8 status;
    }

    mapping(bytes32 => Channel) private _channels;
    uint256 public requestCloseCalls;
    uint256 public withdrawCalls;

    function setChannelBuyer(bytes32 channelId, address buyer) external {
        _channels[channelId].buyer = buyer;
    }

    function channels(
        bytes32 channelId
    )
        external
        view
        returns (
            address buyer,
            address seller,
            uint128 deposit,
            uint128 settled,
            bytes32 metadataHash,
            uint256 deadline,
            uint256 settledAt,
            uint256 closeRequestedAt,
            uint8 status
        )
    {
        Channel memory c = _channels[channelId];
        return (c.buyer, c.seller, c.deposit, c.settled, c.metadataHash, c.deadline, c.settledAt, c.closeRequestedAt, c.status);
    }

    function requestClose(bytes32) external override {
        requestCloseCalls += 1;
    }

    function withdraw(bytes32) external override {
        withdrawCalls += 1;
    }
}

contract MockRegistry is IAntseedRegistry {
    address public override deposits;
    address public override channels;

    constructor(address deposits_, address channels_) {
        deposits = deposits_;
        channels = channels_;
    }
}

contract OperatorCaller {
    AntseedBuyerOperator public operator;

    constructor(AntseedBuyerOperator operator_) {
        operator = operator_;
    }

    function callRequestClose(bytes32 channelId) external returns (bool) {
        try operator.requestClose(channelId) {
            return true;
        } catch {
            return false;
        }
    }

    function callWithdrawChannel(bytes32 channelId) external returns (bool) {
        try operator.withdrawChannel(channelId) {
            return true;
        } catch {
            return false;
        }
    }
}

contract BuyerCaller {
    AntseedBuyerOperator public operator;

    constructor(AntseedBuyerOperator operator_) {
        operator = operator_;
    }

    function callWithdrawPrincipal(uint256 amount, address recipient, uint256 nonce, bytes calldata buyerSig) external returns (bool) {
        try operator.withdrawPrincipal(address(this), amount, recipient, nonce, buyerSig) {
            return true;
        } catch {
            return false;
        }
    }

    function callRevokeOperator(address buyer) external returns (bool) {
        try operator.revokeOperator(buyer) {
            return true;
        } catch {
            return false;
        }
    }
}

contract AntseedBuyerOperatorTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    TestUsdc usdc;
    MockDeposits deposits;
    MockChannels channels;
    MockRegistry registry;
    AntseedBuyerOperator operator;

    address buyer = address(0xB0B);
    address recipient = address(0xCAFE);
    uint256 constant BUYER_PK = 0xBEEF;

    function setUp() public {
        usdc = new TestUsdc();
        deposits = new MockDeposits(usdc);
        channels = new MockChannels();
        registry = new MockRegistry(address(deposits), address(channels));
        AntseedBuyerOperator impl = new AntseedBuyerOperator(address(registry));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), abi.encodeCall(AntseedBuyerOperator.initialize, (address(this))));
        operator = AntseedBuyerOperator(address(proxy));
    }

    function _signWithdraw(uint256 pk, address buyerAddr, uint256 amount, address to, uint256 nonce) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(operator.WITHDRAW_TYPEHASH(), buyerAddr, amount, to, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", operator.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signRequestClose(uint256 pk, bytes32 channelId, uint256 nonce) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(operator.REQUEST_CLOSE_TYPEHASH(), channelId, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", operator.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signWithdrawChannel(uint256 pk, bytes32 channelId, uint256 nonce) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(operator.WITHDRAW_CHANNEL_TYPEHASH(), channelId, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", operator.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signRevokeOperator(uint256 pk, address buyerAddr, uint256 nonce) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(operator.REVOKE_OPERATOR_TYPEHASH(), buyerAddr, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", operator.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function testDepositForFundsBuyerWhenOperatorAccepted() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        operator.acceptBuyerOperator(buyer, 1, "");
        operator.depositFor(buyer, 10_000_000, 2_345_678);

        require(deposits.available(buyer) == 12_345_678, "buyer funded with total");
        require(usdc.balanceOf(address(deposits)) == 12_345_678, "deposits funded");
        require(operator.totalPrincipalDeposited(buyer) == 10_000_000, "principal tracked");
        require(operator.totalBonusDeposited(buyer) == 2_345_678, "bonus tracked");
    }

    function testDepositForWithIdPreventsDuplicates() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);
        operator.acceptBuyerOperator(buyer, 1, "");

        operator.depositForWithId(buyer, 800_000, 200_000, "tx:1");
        require(deposits.available(buyer) == 1_000_000, "funded once");
        require(operator.totalPrincipalDeposited(buyer) == 800_000, "principal tracked");
        require(operator.totalBonusDeposited(buyer) == 200_000, "bonus tracked");

        bool ok;
        try operator.depositForWithId(buyer, 800_000, 200_000, "tx:1") {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "duplicate id rejected");
    }

    function testDepositForWithoutOperatorZeroesBonus() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        operator.depositFor(buyer, 900_000, 100_000);

        require(deposits.available(buyer) == 900_000, "only principal funded");
        require(operator.totalPrincipalDeposited(buyer) == 900_000, "principal tracked");
        require(operator.totalBonusDeposited(buyer) == 0, "bonus forced to zero");
    }

    function testDepositForWithIdWithoutOperatorZeroesBonusAndKeepsIdempotency() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        operator.depositForWithId(buyer, 800_000, 200_000, "tx:no-operator");

        require(deposits.available(buyer) == 800_000, "only principal funded");
        require(operator.totalPrincipalDeposited(buyer) == 800_000, "principal tracked");
        require(operator.totalBonusDeposited(buyer) == 0, "bonus forced to zero");

        bool ok;
        try operator.depositForWithId(buyer, 800_000, 200_000, "tx:no-operator") {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "duplicate id rejected");
    }

    function testDepositWithoutOperatorRejectsZeroTotalAfterBonusWipe() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        bool ok;
        try operator.depositFor(buyer, 0, 100_000) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "zero total rejected after bonus wipe");

        try operator.depositForWithId(buyer, 0, 100_000, "tx:zero-total") {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "zero total rejected after bonus wipe with id");
    }

    function testChannelActionsAllowedForAdminOwnerAndBuyerOnly() public {
        setUp();
        bytes32 channelId = keccak256("channel-1");
        channels.setChannelBuyer(channelId, buyer);
        OperatorCaller ownerCaller = new OperatorCaller(operator);
        operator.transferOwnership(address(ownerCaller));

        operator.requestClose(channelId, 0, "");
        operator.withdrawChannel(channelId, 0, "");
        require(ownerCaller.callRequestClose(channelId), "owner can request close");
        require(ownerCaller.callWithdrawChannel(channelId), "owner can withdraw");

        OperatorCaller buyerCaller = new OperatorCaller(operator);
        channels.setChannelBuyer(channelId, address(buyerCaller));
        require(buyerCaller.callRequestClose(channelId), "buyer can request close");
        require(buyerCaller.callWithdrawChannel(channelId), "buyer can withdraw");

        OperatorCaller outsider = new OperatorCaller(operator);
        channels.setChannelBuyer(channelId, buyer);
        require(!outsider.callRequestClose(channelId), "outsider blocked close");
        require(!outsider.callWithdrawChannel(channelId), "outsider blocked withdraw");
    }

    function testDepositTracksPrincipalAndBonus() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);
        operator.acceptBuyerOperator(buyer, 1, "");

        operator.depositFor(buyer, 4_000_000, 1_000_000);
        require(operator.totalPrincipalDeposited(buyer) == 4_000_000, "principal after depositFor");
        require(operator.totalBonusDeposited(buyer) == 1_000_000, "bonus after depositFor");

        operator.depositForWithId(buyer, 2_000_000, 1_000_000, "tx:track");
        require(operator.totalPrincipalDeposited(buyer) == 6_000_000, "principal after depositForWithId");
        require(operator.totalBonusDeposited(buyer) == 2_000_000, "bonus after depositForWithId");
        // withdrawable is principal only
        require(operator.withdrawablePrincipal(buyer) == 6_000_000, "withdrawable equals principal only");
    }

    function testWithdrawPrincipalWithBuyerSig() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        address buyerAddr = vm.addr(BUYER_PK);
        operator.acceptBuyerOperator(buyerAddr, 1, "");
        operator.depositFor(buyerAddr, 8_000_000, 2_000_000);

        require(operator.withdrawablePrincipal(buyerAddr) == 8_000_000, "full principal withdrawable");

        // Withdraw part of principal
        uint256 nonce1 = operator.usedNonces(buyerAddr);
        bytes memory sig1 = _signWithdraw(BUYER_PK, buyerAddr, 3_000_000, recipient, nonce1);
        operator.withdrawPrincipal(buyerAddr, 3_000_000, recipient, nonce1, sig1);
        require(usdc.balanceOf(recipient) == 3_000_000, "recipient received funds");
        require(operator.totalPrincipalWithdrawn(buyerAddr) == 3_000_000, "withdrawn tracked");
        require(operator.withdrawablePrincipal(buyerAddr) == 5_000_000, "remaining withdrawable");
        require(operator.usedNonces(buyerAddr) == nonce1 + 1, "nonce incremented after withdraw");

        // Withdraw rest of principal
        uint256 nonce2 = operator.usedNonces(buyerAddr);
        bytes memory sig2 = _signWithdraw(BUYER_PK, buyerAddr, 5_000_000, recipient, nonce2);
        operator.withdrawPrincipal(buyerAddr, 5_000_000, recipient, nonce2, sig2);
        require(usdc.balanceOf(recipient) == 8_000_000, "recipient received all principal");
        require(operator.withdrawablePrincipal(buyerAddr) == 0, "nothing left");

        // Cannot withdraw more than principal (bonus not withdrawable)
        uint256 nonce3 = operator.usedNonces(buyerAddr);
        bytes memory sig3 = _signWithdraw(BUYER_PK, buyerAddr, 1, recipient, nonce3);
        bool ok;
        try operator.withdrawPrincipal(buyerAddr, 1, recipient, nonce3, sig3) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "over-withdraw rejected");
    }

    function testWithdrawPrincipalLeavesBonus() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        address buyerAddr = vm.addr(BUYER_PK);
        operator.acceptBuyerOperator(buyerAddr, 1, "");
        operator.depositFor(buyerAddr, 5_000_000, 2_000_000);

        // Total in vault = 7_000_000; only 5_000_000 is principal and thus withdrawable
        require(deposits.available(buyerAddr) == 7_000_000, "full deposit in vault");
        require(operator.withdrawablePrincipal(buyerAddr) == 5_000_000, "only principal withdrawable");

        uint256 nonce = operator.usedNonces(buyerAddr);
        bytes memory sig = _signWithdraw(BUYER_PK, buyerAddr, 5_000_000, recipient, nonce);
        operator.withdrawPrincipal(buyerAddr, 5_000_000, recipient, nonce, sig);

        // Recipient received only the principal
        require(usdc.balanceOf(recipient) == 5_000_000, "recipient got principal");
        // Bonus stays in the deposit vault
        require(deposits.available(buyerAddr) == 2_000_000, "bonus remains in vault");
        require(operator.withdrawablePrincipal(buyerAddr) == 0, "nothing left to withdraw");
    }

    function testUsageConsumesPrincipalBeforeBonusAcrossNewDeposits() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);
        operator.acceptBuyerOperator(buyer, 1, "");

        operator.depositFor(buyer, 10_000_000, 2_000_000);
        deposits.consume(buyer, 3_000_000);
        require(operator.withdrawablePrincipal(buyer) == 7_000_000, "view accounts for pending usage");

        deposits.consume(buyer, 9_000_000);

        operator.depositForWithId(buyer, 5_000_000, 1_000_000, "tx:after-usage");

        require(operator.principalRemaining(buyer) == 5_000_000, "new principal remains");
        require(operator.bonusRemaining(buyer) == 1_000_000, "new bonus remains");
        require(operator.withdrawablePrincipal(buyer) == 5_000_000, "new principal withdrawable");
    }

    function testUsageConsumesPrincipalBeforeBonusAcrossNewDepositsWhenFullyConsumedAtOnce() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);
        operator.acceptBuyerOperator(buyer, 1, "");

        operator.depositFor(buyer, 10_000_000, 2_000_000);
        deposits.consume(buyer, 12_000_000);

        operator.depositForWithId(buyer, 5_000_000, 1_000_000, "tx:after-usage");

        require(operator.principalRemaining(buyer) == 5_000_000, "new principal remains");
        require(operator.bonusRemaining(buyer) == 1_000_000, "new bonus remains");
        require(operator.withdrawablePrincipal(buyer) == 5_000_000, "new principal withdrawable");
    }

    function testRevokeOperatorWithdrawsUnusedAvailableBonus() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        BuyerCaller buyerCaller = new BuyerCaller(operator);
        operator.acceptBuyerOperator(address(buyerCaller), 1, "");
        operator.depositFor(address(buyerCaller), 5_000_000, 2_000_000);

        require(buyerCaller.callRevokeOperator(address(buyerCaller)), "buyer can revoke");

        require(deposits.getOperator(address(buyerCaller)) == address(0), "operator revoked");
        require(deposits.available(address(buyerCaller)) == 5_000_000, "only principal left");
        require(usdc.balanceOf(address(operator)) == 95_000_000, "bonus returned to operator");
        require(operator.bonusRemaining(address(buyerCaller)) == 0, "bonus remaining cleared");
        require(operator.totalBonusWithdrawn(address(buyerCaller)) == 2_000_000, "bonus withdrawal tracked");
    }

    function testRevokeOperatorWithBuyerSig() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        address buyerAddr = vm.addr(BUYER_PK);
        operator.acceptBuyerOperator(buyerAddr, 1, "");
        operator.depositFor(buyerAddr, 4_000_000, 1_000_000);

        uint256 nonce = operator.usedNonces(buyerAddr);
        bytes memory sig = _signRevokeOperator(BUYER_PK, buyerAddr, nonce);

        operator.revokeOperator(buyerAddr, nonce, sig);

        require(deposits.getOperator(buyerAddr) == address(0), "operator revoked");
        require(deposits.available(buyerAddr) == 4_000_000, "bonus reclaimed before revoke");
        require(operator.totalBonusWithdrawn(buyerAddr) == 1_000_000, "bonus withdrawal tracked");
        require(operator.usedNonces(buyerAddr) == nonce + 1, "nonce incremented after revoke");
    }

    function testRevokeOperatorRejectsWrongSigner() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        address buyerAddr = vm.addr(BUYER_PK);
        operator.acceptBuyerOperator(buyerAddr, 1, "");
        operator.depositFor(buyerAddr, 4_000_000, 1_000_000);

        uint256 nonce = operator.usedNonces(buyerAddr);
        bytes memory badSig = _signRevokeOperator(0xDEAD, buyerAddr, nonce);

        bool ok;
        try operator.revokeOperator(buyerAddr, nonce, badSig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "wrong signer rejected");
    }

    function testRevokeOperatorRejectsInvalidNonce() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        address buyerAddr = vm.addr(BUYER_PK);
        operator.acceptBuyerOperator(buyerAddr, 1, "");
        operator.depositFor(buyerAddr, 4_000_000, 1_000_000);

        uint256 nonce = operator.usedNonces(buyerAddr);
        bytes memory sig = _signRevokeOperator(BUYER_PK, buyerAddr, nonce);

        bool ok;
        try operator.revokeOperator(buyerAddr, nonce + 1, sig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "invalid nonce rejected");
    }

    function testWithdrawPrincipalRejectsWrongSigner() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        address buyerAddr = vm.addr(BUYER_PK);
        operator.acceptBuyerOperator(buyerAddr, 1, "");
        operator.depositFor(buyerAddr, 10_000_000, 0);

        // Sign with a different private key (not the buyer)
        uint256 wrongPk = 0xDEAD;
        uint256 nonce = operator.usedNonces(buyerAddr);
        bytes memory badSig = _signWithdraw(wrongPk, buyerAddr, 1_000_000, recipient, nonce);
        bool ok;
        try operator.withdrawPrincipal(buyerAddr, 1_000_000, recipient, nonce, badSig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "wrong signer rejected");
    }

    function testWithdrawPrincipalRejectsInvalidNonce() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        address buyerAddr = vm.addr(BUYER_PK);
        operator.acceptBuyerOperator(buyerAddr, 1, "");
        operator.depositFor(buyerAddr, 10_000_000, 0);

        uint256 nonce = operator.usedNonces(buyerAddr);
        bytes memory sig = _signWithdraw(BUYER_PK, buyerAddr, 1_000_000, recipient, nonce);

        bool ok;
        try operator.withdrawPrincipal(buyerAddr, 1_000_000, recipient, nonce + 1, sig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "invalid nonce rejected");
    }

    function testRequestCloseWithBuyerSig() public {
        setUp();
        bytes32 channelId = keccak256("channel-sig");
        address buyerAddr = vm.addr(BUYER_PK);
        channels.setChannelBuyer(channelId, buyerAddr);

        uint256 nonce = operator.usedNonces(buyerAddr);
        bytes memory sig = _signRequestClose(BUYER_PK, channelId, nonce);
        operator.requestClose(channelId, nonce, sig);
        require(channels.requestCloseCalls() == 1, "requestClose forwarded");
        require(operator.usedNonces(buyerAddr) == nonce + 1, "nonce incremented after requestClose");
    }

    function testRequestCloseRejectsWrongSigner() public {
        setUp();
        bytes32 channelId = keccak256("channel-sig");
        address buyerAddr = vm.addr(BUYER_PK);
        channels.setChannelBuyer(channelId, buyerAddr);

        uint256 nonce = operator.usedNonces(buyerAddr);
        bytes memory badSig = _signRequestClose(0xDEAD, channelId, nonce);
        bool ok;
        try operator.requestClose(channelId, nonce, badSig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "wrong signer rejected");
    }

    function testRequestCloseRejectsInvalidNonce() public {
        setUp();
        bytes32 channelId = keccak256("channel-sig");
        address buyerAddr = vm.addr(BUYER_PK);
        channels.setChannelBuyer(channelId, buyerAddr);

        uint256 nonce = operator.usedNonces(buyerAddr);
        bytes memory sig = _signRequestClose(BUYER_PK, channelId, nonce);
        bool ok;
        try operator.requestClose(channelId, nonce + 1, sig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "invalid nonce rejected");
    }

    function testWithdrawChannelWithBuyerSig() public {
        setUp();
        bytes32 channelId = keccak256("channel-sig");
        address buyerAddr = vm.addr(BUYER_PK);
        channels.setChannelBuyer(channelId, buyerAddr);

        uint256 nonce = operator.usedNonces(buyerAddr);
        bytes memory sig = _signWithdrawChannel(BUYER_PK, channelId, nonce);
        operator.withdrawChannel(channelId, nonce, sig);
        require(channels.withdrawCalls() == 1, "withdrawChannel forwarded");
        require(operator.usedNonces(buyerAddr) == nonce + 1, "nonce incremented after withdrawChannel");
    }

    function testWithdrawChannelRejectsWrongSigner() public {
        setUp();
        bytes32 channelId = keccak256("channel-sig");
        address buyerAddr = vm.addr(BUYER_PK);
        channels.setChannelBuyer(channelId, buyerAddr);

        uint256 nonce = operator.usedNonces(buyerAddr);
        bytes memory badSig = _signWithdrawChannel(0xDEAD, channelId, nonce);
        bool ok;
        try operator.withdrawChannel(channelId, nonce, badSig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "wrong signer rejected");
    }

    function testWithdrawChannelRejectsInvalidNonce() public {
        setUp();
        bytes32 channelId = keccak256("channel-sig");
        address buyerAddr = vm.addr(BUYER_PK);
        channels.setChannelBuyer(channelId, buyerAddr);

        uint256 nonce = operator.usedNonces(buyerAddr);
        bytes memory sig = _signWithdrawChannel(BUYER_PK, channelId, nonce);
        bool ok;
        try operator.withdrawChannel(channelId, nonce + 1, sig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "invalid nonce rejected");
    }

    function testCannotReinitialize() public {
        setUp();
        (bool ok, ) = address(operator).call(abi.encodeCall(AntseedBuyerOperator.initialize, (address(this))));
        require(!ok, "double init rejected");
    }

    function testOnlyOwnerCanUpgrade() public {
        setUp();
        AntseedBuyerOperator newImpl = new AntseedBuyerOperator(address(registry));

        // owner (equals admin at init) can upgrade
        operator.upgradeToAndCall(address(newImpl), "");

        // outsider cannot upgrade
        OperatorUpgradeHelper outsider = new OperatorUpgradeHelper();
        (bool ok, ) = address(outsider).call(abi.encodeWithSignature("upgrade(address,address)", address(operator), address(newImpl)));
        require(!ok, "outsider upgrade rejected");

        // transfer ownership away; address(this) remains admin but loses owner role
        AdminActor newOwnerActor = new AdminActor(operator);
        operator.transferOwnership(address(newOwnerActor));

        // admin-without-owner is now blocked by onlyOwner
        (ok, ) = address(operator).call(abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(newImpl), bytes("")));
        require(!ok, "admin-without-owner upgrade rejected");
    }

    // ─── transferOwnership ───

    function testTransferOwnershipWorks() public {
        setUp();
        address newOwner = address(0xA11CE);
        operator.transferOwnership(newOwner);
        require(operator.owner() == newOwner, "owner updated");
    }

    function testTransferOwnershipRejectsZeroAddress() public {
        setUp();
        (bool ok, ) = address(operator).call(abi.encodeWithSignature("transferOwnership(address)", address(0)));
        require(!ok, "zero-address transferOwnership rejected");
    }

    function testTransferOwnershipRejectedByOutsider() public {
        setUp();
        AdminActor outsider = new AdminActor(operator);
        // outsider is neither owner nor admin
        (bool ok, ) = address(outsider).call(abi.encodeWithSignature("callTransferOwnership(address)", address(outsider)));
        require(!ok, "outsider cannot transferOwnership");
    }

    // ─── transferAdmin ───

    function testTransferAdminWorks() public {
        setUp();
        AdminActor newAdminActor = new AdminActor(operator);
        operator.transferAdmin(address(newAdminActor));
        require(operator.admin() == address(newAdminActor), "admin updated");
        // new admin can exercise operational functions
        usdc.mint(address(operator), 1_000_000);
        newAdminActor.callAcceptBuyerOperator(buyer, 1);
        newAdminActor.callDepositFor(buyer, 500_000, 100_000);
        require(deposits.available(buyer) == 600_000, "new admin funded buyer");
    }

    function testTransferAdminRejectsZeroAddress() public {
        setUp();
        (bool ok, ) = address(operator).call(abi.encodeWithSignature("transferAdmin(address)", address(0)));
        require(!ok, "zero-address transferAdmin rejected");
    }

    function testTransferAdminOnlyCallableByAdminOrOwner() public {
        setUp();
        AdminActor outsider = new AdminActor(operator);
        // outsider (neither owner nor admin) cannot call transferAdmin
        (bool ok, ) = address(outsider).call(abi.encodeWithSignature("callTransferAdmin(address)", address(outsider)));
        require(!ok, "outsider cannot transferAdmin");
    }

    function testAdminAfterOwnershipTransferCannotCallOnlyOwner() public {
        setUp();
        // Transfer ownership away; address(this) remains admin but is no longer owner.
        AdminActor newOwnerActor = new AdminActor(operator);
        operator.transferOwnership(address(newOwnerActor));

        usdc.mint(address(operator), 1_000_000);

        // address(this) can no longer call onlyOwner functions
        (bool ok, ) = address(operator).call(abi.encodeWithSignature("sweepToken(address,address,uint256)", address(usdc), recipient, uint256(1_000_000)));
        require(!ok, "admin-without-owner cannot sweepToken");

        operator.transferAdmin(address(this));
        require(operator.admin() == address(this), "admin-without-owner can transferAdmin");
    }

    // ─── onlyAdmin: owner can also call ───

    function testOwnerCanCallOnlyAdminFunctions() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        operator.acceptBuyerOperator(buyer, 1, "");
        operator.depositFor(buyer, 500_000, 100_000);
        require(deposits.available(buyer) == 600_000, "owner funded buyer");
        require(operator.totalPrincipalDeposited(buyer) == 500_000, "principal tracked via owner");
        require(operator.totalBonusDeposited(buyer) == 100_000, "bonus tracked via owner");
    }

    function testAdminCannotUpgrade() public {
        setUp();
        AntseedBuyerOperator newImpl = new AntseedBuyerOperator(address(registry));
        AdminActor adminActor = new AdminActor(operator);
        operator.transferAdmin(address(adminActor));
        // admin (not owner) cannot trigger upgradeToAndCall
        (bool ok, ) = address(adminActor).call(abi.encodeWithSignature("callUpgrade(address,address)", address(operator), address(newImpl)));
        require(!ok, "admin cannot upgrade");
    }

    // ─── onlyAdmin: outsider rejected ───

    function testOnlyAdminFunctionsRejectOutsider() public {
        setUp();
        AdminActor outsider = new AdminActor(operator);

        (bool ok, ) = address(outsider).call(abi.encodeWithSignature("callAcceptBuyerOperator(address,uint256)", buyer, uint256(1)));
        require(!ok, "outsider cannot acceptBuyerOperator");

        (ok, ) = address(outsider).call(abi.encodeWithSignature("callDepositFor(address,uint256,uint256)", buyer, uint256(1), uint256(0)));
        require(!ok, "outsider cannot depositFor");

        (ok, ) = address(outsider).call(abi.encodeWithSignature("callApproveCurrentDeposits()"));
        require(!ok, "outsider cannot approveCurrentDeposits");
    }

    // ─── sweepToken ───

    function testSweepTokenWorks() public {
        setUp();
        usdc.mint(address(operator), 5_000_000);
        operator.sweepToken(address(usdc), recipient, 5_000_000);
        require(usdc.balanceOf(recipient) == 5_000_000, "token swept to recipient");
    }

    function testSweepTokenRejectsInvalidArgs() public {
        setUp();
        usdc.mint(address(operator), 1_000_000);

        (bool ok, ) = address(operator).call(abi.encodeWithSignature("sweepToken(address,address,uint256)", address(0), recipient, uint256(1)));
        require(!ok, "zero token address rejected");

        (ok, ) = address(operator).call(abi.encodeWithSignature("sweepToken(address,address,uint256)", address(usdc), address(0), uint256(1)));
        require(!ok, "zero recipient rejected");

        (ok, ) = address(operator).call(abi.encodeWithSignature("sweepToken(address,address,uint256)", address(usdc), recipient, uint256(0)));
        require(!ok, "zero amount rejected");
    }

    // ─── approveCurrentDeposits ───

    function testApproveCurrentDepositsOnlyAdmin() public {
        setUp();
        // owner can call admin operations too
        operator.approveCurrentDeposits();

        // outsider cannot
        AdminActor outsider = new AdminActor(operator);
        (bool ok, ) = address(outsider).call(abi.encodeWithSignature("callApproveCurrentDeposits()"));
        require(!ok, "outsider cannot approveCurrentDeposits");
    }

    // ─── removed admin paths ───

    /// @dev The admin must have no way to hand a buyer's operator role to an arbitrary address.
    function testRemovedAdminFunctionsAreNotCallable() public {
        setUp();
        operator.acceptBuyerOperator(buyer, 1, "");

        (bool ok, ) = address(operator).call(abi.encodeWithSignature("transferBuyerOperator(address,address)", buyer, address(0xBAD)));
        require(!ok, "transferBuyerOperator removed");
        require(deposits.getOperator(buyer) == address(operator), "operator unchanged");

        (ok, ) = address(operator).call(abi.encodeWithSignature("migrateBuyerAccounting(address)", buyer));
        require(!ok, "migrateBuyerAccounting(address) removed");

        address[] memory buyers = new address[](1);
        buyers[0] = buyer;
        (ok, ) = address(operator).call(abi.encodeWithSignature("migrateBuyerAccounting(address[])", buyers));
        require(!ok, "migrateBuyerAccounting(address[]) removed");

        (ok, ) = address(operator).call(abi.encodeWithSignature("buyerAccountingMigrated(address)", buyer));
        require(!ok, "buyerAccountingMigrated getter removed");
    }

    /// @dev Revoking is the remaining way out: it must still release the buyer's operator slot and unused bonus.
    function testRevokeOperatorStillWorksAfterAccountingRemoval() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);
        operator.acceptBuyerOperator(buyer, 1, "");
        operator.depositFor(buyer, 5_000_000, 2_000_000);

        operator.revokeOperator(buyer);

        require(deposits.getOperator(buyer) == address(0), "operator revoked");
        require(deposits.available(buyer) == 5_000_000, "principal left in deposits");
        require(operator.totalBonusWithdrawn(buyer) == 2_000_000, "unused bonus clawed back");
    }

    // ─── ERC-1271 ───

    function _requireInvalidSignature(bytes memory callData, string memory reason) internal {
        (bool ok, bytes memory ret) = address(operator).call(callData);
        require(!ok && bytes4(ret) == AntseedBuyerOperator.InvalidSignature.selector, reason);
    }

    function testWithdrawPrincipalWithErc1271WalletSig() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);
        address wallet = address(new Mock1271Wallet(vm.addr(BUYER_PK)));
        operator.acceptBuyerOperator(wallet, 1, "");
        operator.depositFor(wallet, 5_000_000, 1_000_000);

        bytes memory sig = _signWithdraw(BUYER_PK, wallet, 2_000_000, recipient, 0);
        operator.withdrawPrincipal(wallet, 2_000_000, recipient, 0, sig);

        require(usdc.balanceOf(recipient) == 2_000_000, "recipient paid");
        require(operator.usedNonces(wallet) == 1, "nonce consumed");

        (bool ok, ) = address(operator).call(abi.encodeCall(AntseedBuyerOperator.withdrawPrincipal, (wallet, 2_000_000, recipient, 0, sig)));
        require(!ok, "replay rejected");
    }

    function testErc1271WalletRejectsSigFromOtherKey() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);
        address wallet = address(new Mock1271Wallet(vm.addr(BUYER_PK)));
        operator.acceptBuyerOperator(wallet, 1, "");
        operator.depositFor(wallet, 5_000_000, 1_000_000);

        bytes memory badSig = _signWithdraw(0xDEAD, wallet, 2_000_000, recipient, 0);
        _requireInvalidSignature(
            abi.encodeCall(AntseedBuyerOperator.withdrawPrincipal, (wallet, 2_000_000, recipient, 0, badSig)),
            "wallet rejected foreign key"
        );
        require(operator.usedNonces(wallet) == 0, "nonce untouched");
    }

    function testRevokeOperatorWithErc1271WalletSig() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);
        address wallet = address(new Mock1271Wallet(vm.addr(BUYER_PK)));
        operator.acceptBuyerOperator(wallet, 1, "");
        operator.depositFor(wallet, 4_000_000, 1_000_000);

        operator.revokeOperator(wallet, 0, _signRevokeOperator(BUYER_PK, wallet, 0));

        require(deposits.getOperator(wallet) == address(0), "operator revoked");
        require(operator.totalBonusWithdrawn(wallet) == 1_000_000, "bonus clawed back");
        require(operator.usedNonces(wallet) == 1, "nonce consumed");
    }

    function testChannelActionsWithErc1271WalletSig() public {
        setUp();
        bytes32 channelId = keccak256("channel-1271");
        address wallet = address(new Mock1271Wallet(vm.addr(BUYER_PK)));
        channels.setChannelBuyer(channelId, wallet);

        operator.requestClose(channelId, 0, _signRequestClose(BUYER_PK, channelId, 0));
        operator.withdrawChannel(channelId, 1, _signWithdrawChannel(BUYER_PK, channelId, 1));

        require(channels.requestCloseCalls() == 1, "requestClose forwarded");
        require(channels.withdrawCalls() == 1, "withdrawChannel forwarded");
        require(operator.usedNonces(wallet) == 2, "both nonces consumed");

        _requireInvalidSignature(
            abi.encodeWithSignature("requestClose(bytes32,uint256,bytes)", channelId, uint256(2), _signRequestClose(0xDEAD, channelId, 2)),
            "requestClose rejects foreign key"
        );
        _requireInvalidSignature(
            abi.encodeWithSignature("withdrawChannel(bytes32,uint256,bytes)", channelId, uint256(2), _signWithdrawChannel(0xDEAD, channelId, 2)),
            "withdrawChannel rejects foreign key"
        );
    }

    function testContractBuyerWithoutErc1271IsRejected() public {
        setUp();
        bytes32 channelId = keccak256("channel-no-1271");
        channels.setChannelBuyer(channelId, address(new OperatorCaller(operator)));

        _requireInvalidSignature(
            abi.encodeWithSignature("requestClose(bytes32,uint256,bytes)", channelId, uint256(0), _signRequestClose(BUYER_PK, channelId, 0)),
            "contract without isValidSignature rejected"
        );
        require(channels.requestCloseCalls() == 0, "nothing forwarded");
    }

    /// @dev EIP-7702 EOAs have code; their own key must still work when the delegate lacks ERC-1271.
    function testEoaWithCodeStillAcceptsEcdsaSig() public {
        setUp();
        bytes32 channelId = keccak256("channel-7702");
        address buyerAddr = vm.addr(BUYER_PK);
        vm.etch(buyerAddr, hex"00");
        channels.setChannelBuyer(channelId, buyerAddr);

        operator.requestClose(channelId, 0, _signRequestClose(BUYER_PK, channelId, 0));

        require(channels.requestCloseCalls() == 1, "requestClose forwarded");
        require(operator.usedNonces(buyerAddr) == 1, "nonce consumed");
    }
}

/// @dev Helper that forwards calls as a separate msg.sender so tests can simulate
///      an admin or outsider address distinct from address(this).
contract AdminActor {
    AntseedBuyerOperator public operator;

    constructor(AntseedBuyerOperator op) {
        operator = op;
    }

    function callTransferOwnership(address to) external {
        operator.transferOwnership(to);
    }

    function callTransferAdmin(address to) external {
        operator.transferAdmin(to);
    }

    function callAcceptBuyerOperator(address buyer_, uint256 nonce) external {
        operator.acceptBuyerOperator(buyer_, nonce, "");
    }

    function callDepositFor(address buyer_, uint256 principal, uint256 bonus) external {
        operator.depositFor(buyer_, principal, bonus);
    }

    function callSweepToken(address token_, address recipient_, uint256 amount) external {
        operator.sweepToken(token_, recipient_, amount);
    }

    function callApproveCurrentDeposits() external {
        operator.approveCurrentDeposits();
    }

    function callUpgrade(address proxy, address newImpl) external {
        AntseedBuyerOperator(proxy).upgradeToAndCall(newImpl, "");
    }
}

contract OperatorUpgradeHelper {
    function upgrade(address op, address newImpl) external {
        AntseedBuyerOperator(op).upgradeToAndCall(newImpl, "");
    }
}
