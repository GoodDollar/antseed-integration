// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AntseedBuyerOperator, IERC20} from "../src/AntseedBuyerOperator.sol";
import {IAntseedChannels} from "../src/interfaces/IAntseedChannels.sol";
import {IAntseedDeposits} from "../src/interfaces/IAntseedDeposits.sol";
import {IAntseedRegistry} from "../src/interfaces/IAntseedRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface Vm {
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);

    function addr(uint256 privateKey) external pure returns (address);

    function warp(uint256 newTimestamp) external;
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

    function callWithdrawPrincipal(uint256 amount, address recipient, uint256 timestamp, bytes calldata buyerSig) external returns (bool) {
        try operator.withdrawPrincipal(address(this), amount, recipient, timestamp, buyerSig) {
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

    function _signWithdraw(uint256 pk, address buyerAddr, uint256 amount, address to, uint256 timestamp) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(operator.WITHDRAW_TYPEHASH(), buyerAddr, amount, to, timestamp));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", operator.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signRequestClose(uint256 pk, bytes32 channelId, uint256 timestamp) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(operator.REQUEST_CLOSE_TYPEHASH(), channelId, timestamp));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", operator.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signWithdrawChannel(uint256 pk, bytes32 channelId, uint256 timestamp) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(operator.WITHDRAW_CHANNEL_TYPEHASH(), channelId, timestamp));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", operator.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signRevokeOperator(uint256 pk, address buyerAddr, uint256 timestamp) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(operator.REVOKE_OPERATOR_TYPEHASH(), buyerAddr, timestamp));
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
        uint256 ts1 = block.timestamp;
        bytes memory sig1 = _signWithdraw(BUYER_PK, buyerAddr, 3_000_000, recipient, ts1);
        operator.withdrawPrincipal(buyerAddr, 3_000_000, recipient, ts1, sig1);
        require(usdc.balanceOf(recipient) == 3_000_000, "recipient received funds");
        require(operator.totalPrincipalWithdrawn(buyerAddr) == 3_000_000, "withdrawn tracked");
        require(operator.withdrawablePrincipal(buyerAddr) == 5_000_000, "remaining withdrawable");

        // Withdraw rest of principal
        vm.warp(block.timestamp + 1);
        uint256 ts2 = block.timestamp;
        bytes memory sig2 = _signWithdraw(BUYER_PK, buyerAddr, 5_000_000, recipient, ts2);
        operator.withdrawPrincipal(buyerAddr, 5_000_000, recipient, ts2, sig2);
        require(usdc.balanceOf(recipient) == 8_000_000, "recipient received all principal");
        require(operator.withdrawablePrincipal(buyerAddr) == 0, "nothing left");

        // Cannot withdraw more than principal (bonus not withdrawable)
        vm.warp(block.timestamp + 1);
        uint256 ts3 = block.timestamp;
        bytes memory sig3 = _signWithdraw(BUYER_PK, buyerAddr, 1, recipient, ts3);
        bool ok;
        try operator.withdrawPrincipal(buyerAddr, 1, recipient, ts3, sig3) {
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

        uint256 ts = block.timestamp;
        bytes memory sig = _signWithdraw(BUYER_PK, buyerAddr, 5_000_000, recipient, ts);
        operator.withdrawPrincipal(buyerAddr, 5_000_000, recipient, ts, sig);

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

        uint256 ts = block.timestamp;
        bytes memory sig = _signRevokeOperator(BUYER_PK, buyerAddr, ts);

        operator.revokeOperator(buyerAddr, ts, sig);

        require(deposits.getOperator(buyerAddr) == address(0), "operator revoked");
        require(deposits.available(buyerAddr) == 4_000_000, "bonus reclaimed before revoke");
        require(operator.totalBonusWithdrawn(buyerAddr) == 1_000_000, "bonus withdrawal tracked");
    }

    function testRevokeOperatorRejectsWrongSigner() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        address buyerAddr = vm.addr(BUYER_PK);
        operator.acceptBuyerOperator(buyerAddr, 1, "");
        operator.depositFor(buyerAddr, 4_000_000, 1_000_000);

        uint256 ts = block.timestamp;
        bytes memory badSig = _signRevokeOperator(0xDEAD, buyerAddr, ts);

        bool ok;
        try operator.revokeOperator(buyerAddr, ts, badSig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "wrong signer rejected");
    }

    function testRevokeOperatorRejectsExpiredTimestamp() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        address buyerAddr = vm.addr(BUYER_PK);
        operator.acceptBuyerOperator(buyerAddr, 1, "");
        operator.depositFor(buyerAddr, 4_000_000, 1_000_000);

        uint256 ts = block.timestamp;
        bytes memory sig = _signRevokeOperator(BUYER_PK, buyerAddr, ts);

        vm.warp(ts + 6 minutes);

        bool ok;
        try operator.revokeOperator(buyerAddr, ts, sig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "expired timestamp rejected");
    }

    function testMigrateBuyerAccountingComputesRemainingFromTrackedTotals() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        operator.acceptBuyerOperator(buyer, 1, "");
        operator.depositFor(buyer, 10_000_000, 2_000_000);
        deposits.consume(buyer, 3_000_000);

        operator.migrateBuyerAccounting(buyer);

        require(operator.principalRemaining(buyer) == 7_000_000, "principal recomputed");
        require(operator.bonusRemaining(buyer) == 2_000_000, "bonus recomputed");
        require(operator.lastAccountedBalance(buyer) == 9_000_000, "accounted balance set");
        require(operator.buyerAccountingMigrated(buyer), "migration flagged");

        bool ok;
        try operator.migrateBuyerAccounting(buyer) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "double migration rejected");
    }

    function testMigrateBuyerAccountingBatch() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        address buyer2 = address(0xB0C);

        operator.acceptBuyerOperator(buyer, 1, "");
        operator.acceptBuyerOperator(buyer2, 1, "");

        operator.depositFor(buyer, 10_000_000, 2_000_000);
        operator.depositFor(buyer2, 6_000_000, 1_000_000);

        deposits.consume(buyer, 3_000_000);
        deposits.consume(buyer2, 1_500_000);

        address[] memory buyers = new address[](2);
        buyers[0] = buyer;
        buyers[1] = buyer2;
        operator.migrateBuyerAccounting(buyers);

        require(operator.principalRemaining(buyer) == 7_000_000, "buyer1 principal recomputed");
        require(operator.bonusRemaining(buyer) == 2_000_000, "buyer1 bonus recomputed");
        require(operator.lastAccountedBalance(buyer) == 9_000_000, "buyer1 accounted balance set");

        require(operator.principalRemaining(buyer2) == 4_500_000, "buyer2 principal recomputed");
        require(operator.bonusRemaining(buyer2) == 1_000_000, "buyer2 bonus recomputed");
        require(operator.lastAccountedBalance(buyer2) == 5_500_000, "buyer2 accounted balance set");

        require(operator.buyerAccountingMigrated(buyer), "buyer1 migration flagged");
        require(operator.buyerAccountingMigrated(buyer2), "buyer2 migration flagged");
    }

    function testTransferBuyerOperatorWithdrawsOnlyAvailableBonus() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);
        operator.acceptBuyerOperator(buyer, 1, "");
        operator.depositFor(buyer, 5_000_000, 2_000_000);
        deposits.reserve(buyer, 2_000_000);

        address newOp = address(0xC0DE);
        operator.transferBuyerOperator(buyer, newOp);

        require(deposits.getOperator(buyer) == newOp, "operator transferred");
        require(deposits.available(buyer) == 5_000_000, "available principal preserved");
        require(deposits.reserved(buyer) == 2_000_000, "reserved funds untouched");
        require(operator.totalBonusWithdrawn(buyer) == 0, "reserved bonus not withdrawn");
    }

    function testTransferBuyerOperatorAfterNonOperatorFundingKeepsPrincipalIntact() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        operator.depositFor(buyer, 3_000_000, 1_000_000);

        address newOp = address(0xA11CE);
        operator.transferBuyerOperator(buyer, newOp);

        require(deposits.getOperator(buyer) == newOp, "operator transferred");
        require(deposits.available(buyer) == 3_000_000, "principal untouched");
        require(operator.totalBonusDeposited(buyer) == 0, "bonus never credited");
        require(operator.totalBonusWithdrawn(buyer) == 0, "no bonus withdrawal");
    }

    function testWithdrawPrincipalRejectsWrongSigner() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        address buyerAddr = vm.addr(BUYER_PK);
        operator.acceptBuyerOperator(buyerAddr, 1, "");
        operator.depositFor(buyerAddr, 10_000_000, 0);

        // Sign with a different private key (not the buyer)
        uint256 wrongPk = 0xDEAD;
        uint256 ts = block.timestamp;
        bytes memory badSig = _signWithdraw(wrongPk, buyerAddr, 1_000_000, recipient, ts);
        bool ok;
        try operator.withdrawPrincipal(buyerAddr, 1_000_000, recipient, ts, badSig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "wrong signer rejected");
    }

    function testWithdrawPrincipalRejectsExpiredTimestamp() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        address buyerAddr = vm.addr(BUYER_PK);
        operator.acceptBuyerOperator(buyerAddr, 1, "");
        operator.depositFor(buyerAddr, 10_000_000, 0);

        uint256 ts = block.timestamp;
        bytes memory sig = _signWithdraw(BUYER_PK, buyerAddr, 1_000_000, recipient, ts);

        // Warp 6 minutes into the future so the timestamp is expired
        vm.warp(ts + 6 minutes);

        bool ok;
        try operator.withdrawPrincipal(buyerAddr, 1_000_000, recipient, ts, sig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "expired timestamp rejected");
    }

    function testRequestCloseWithBuyerSig() public {
        setUp();
        bytes32 channelId = keccak256("channel-sig");
        address buyerAddr = vm.addr(BUYER_PK);
        channels.setChannelBuyer(channelId, buyerAddr);

        uint256 ts = block.timestamp;
        bytes memory sig = _signRequestClose(BUYER_PK, channelId, ts);
        operator.requestClose(channelId, ts, sig);
        require(channels.requestCloseCalls() == 1, "requestClose forwarded");
    }

    function testRequestCloseRejectsWrongSigner() public {
        setUp();
        bytes32 channelId = keccak256("channel-sig");
        address buyerAddr = vm.addr(BUYER_PK);
        channels.setChannelBuyer(channelId, buyerAddr);

        uint256 ts = block.timestamp;
        bytes memory badSig = _signRequestClose(0xDEAD, channelId, ts);
        bool ok;
        try operator.requestClose(channelId, ts, badSig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "wrong signer rejected");
    }

    function testRequestCloseRejectsExpiredTimestamp() public {
        setUp();
        bytes32 channelId = keccak256("channel-sig");
        address buyerAddr = vm.addr(BUYER_PK);
        channels.setChannelBuyer(channelId, buyerAddr);

        uint256 ts = block.timestamp;
        bytes memory sig = _signRequestClose(BUYER_PK, channelId, ts);
        vm.warp(ts + 6 minutes);
        bool ok;
        try operator.requestClose(channelId, ts, sig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "expired timestamp rejected");
    }

    function testWithdrawChannelWithBuyerSig() public {
        setUp();
        bytes32 channelId = keccak256("channel-sig");
        address buyerAddr = vm.addr(BUYER_PK);
        channels.setChannelBuyer(channelId, buyerAddr);

        uint256 ts = block.timestamp;
        bytes memory sig = _signWithdrawChannel(BUYER_PK, channelId, ts);
        operator.withdrawChannel(channelId, ts, sig);
        require(channels.withdrawCalls() == 1, "withdrawChannel forwarded");
    }

    function testWithdrawChannelRejectsWrongSigner() public {
        setUp();
        bytes32 channelId = keccak256("channel-sig");
        address buyerAddr = vm.addr(BUYER_PK);
        channels.setChannelBuyer(channelId, buyerAddr);

        uint256 ts = block.timestamp;
        bytes memory badSig = _signWithdrawChannel(0xDEAD, channelId, ts);
        bool ok;
        try operator.withdrawChannel(channelId, ts, badSig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "wrong signer rejected");
    }

    function testWithdrawChannelRejectsExpiredTimestamp() public {
        setUp();
        bytes32 channelId = keccak256("channel-sig");
        address buyerAddr = vm.addr(BUYER_PK);
        channels.setChannelBuyer(channelId, buyerAddr);

        uint256 ts = block.timestamp;
        bytes memory sig = _signWithdrawChannel(BUYER_PK, channelId, ts);
        vm.warp(ts + 6 minutes);
        bool ok;
        try operator.withdrawChannel(channelId, ts, sig) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "expired timestamp rejected");
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

        (ok, ) = address(outsider).call(abi.encodeWithSignature("callTransferBuyerOperator(address,address)", buyer, address(outsider)));
        require(!ok, "outsider cannot transferBuyerOperator");
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

    // ─── transferBuyerOperator ───

    function testTransferBuyerOperatorWorks() public {
        setUp();
        operator.acceptBuyerOperator(buyer, 1, "");
        address newOp = address(0xC0DE);
        operator.transferBuyerOperator(buyer, newOp);
        require(deposits.getOperator(buyer) == newOp, "operator transferred");
    }

    function testTransferBuyerOperatorOnlyAdmin() public {
        setUp();
        operator.acceptBuyerOperator(buyer, 1, "");
        AdminActor outsider = new AdminActor(operator);
        (bool ok, ) = address(outsider).call(abi.encodeWithSignature("callTransferBuyerOperator(address,address)", buyer, address(outsider)));
        require(!ok, "outsider cannot transferBuyerOperator");
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

    function callTransferBuyerOperator(address buyer_, address newOp) external {
        operator.transferBuyerOperator(buyer_, newOp);
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
