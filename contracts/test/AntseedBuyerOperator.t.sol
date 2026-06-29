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

    function channels(bytes32 channelId)
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
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AntseedBuyerOperator.initialize, (address(this)))
        );
        operator = AntseedBuyerOperator(address(proxy));
    }

    function _signWithdraw(uint256 pk, address buyerAddr, uint256 amount, address to, uint256 timestamp) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            operator.WITHDRAW_TYPEHASH(),
            buyerAddr,
            amount,
            to,
            timestamp
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", operator.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signRequestClose(uint256 pk, bytes32 channelId, uint256 timestamp) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            operator.REQUEST_CLOSE_TYPEHASH(),
            channelId,
            timestamp
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", operator.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signWithdrawChannel(uint256 pk, bytes32 channelId, uint256 timestamp) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            operator.WITHDRAW_CHANNEL_TYPEHASH(),
            channelId,
            timestamp
        ));
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

    function testDepositRevertsIfOperatorNotSet() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        bool ok;
        try operator.depositFor(buyer, 900_000, 100_000) {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "must reject without operator");
    }

    function testChannelActionsAllowedForOwnerAndBuyerOnly() public {
        setUp();
        bytes32 channelId = keccak256("channel-1");
        channels.setChannelBuyer(channelId, buyer);

        operator.requestClose(channelId, 0, "");
        operator.withdrawChannel(channelId, 0, "");

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
        require(operator.totalWithdrawn(buyerAddr) == 3_000_000, "withdrawn tracked");
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
        try operator.requestClose(channelId, ts, badSig) { ok = true; } catch { ok = false; }
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
        try operator.requestClose(channelId, ts, sig) { ok = true; } catch { ok = false; }
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
        try operator.withdrawChannel(channelId, ts, badSig) { ok = true; } catch { ok = false; }
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
        try operator.withdrawChannel(channelId, ts, sig) { ok = true; } catch { ok = false; }
        require(!ok, "expired timestamp rejected");
    }

    function testCannotReinitialize() public {
        setUp();
        (bool ok,) = address(operator).call(
            abi.encodeCall(AntseedBuyerOperator.initialize, (address(this)))
        );
        require(!ok, "double init rejected");
    }

    function testOnlyOwnerCanUpgrade() public {
        setUp();
        AntseedBuyerOperator newImpl = new AntseedBuyerOperator(address(registry));
        // owner (address(this)) can call upgradeToAndCall
        operator.upgradeToAndCall(address(newImpl), "");

        // non-owner cannot
        OperatorUpgradeHelper outsider = new OperatorUpgradeHelper();
        (bool ok,) = address(outsider).call(
            abi.encodeWithSignature("upgrade(address,address)", address(operator), address(newImpl))
        );
        require(!ok, "non-owner upgrade rejected");
    }
}

contract OperatorUpgradeHelper {
    function upgrade(address op, address newImpl) external {
        AntseedBuyerOperator(op).upgradeToAndCall(newImpl, "");
    }
}
