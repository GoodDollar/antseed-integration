// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AntseedBuyerOperator, IERC20} from "../src/AntseedBuyerOperator.sol";
import {IAntseedChannels} from "../src/interfaces/IAntseedChannels.sol";
import {IAntseedDeposits} from "../src/interfaces/IAntseedDeposits.sol";
import {IAntseedRegistry} from "../src/interfaces/IAntseedRegistry.sol";

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

contract AntseedBuyerOperatorTest {
    TestUsdc usdc;
    MockDeposits deposits;
    MockChannels channels;
    MockRegistry registry;
    AntseedBuyerOperator operator;

    address buyer = address(0xB0B);
    address recipient = address(0xCAFE);

    function setUp() public {
        usdc = new TestUsdc();
        deposits = new MockDeposits(usdc);
        channels = new MockChannels();
        registry = new MockRegistry(address(deposits), address(channels));
        operator = new AntseedBuyerOperator(address(registry));
    }

    function testDepositForFundsBuyerWhenOperatorAccepted() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        operator.acceptBuyerOperator(buyer, 1, "");
        operator.depositFor(buyer, 12_345_678);

        require(deposits.available(buyer) == 12_345_678, "buyer funded");
        require(usdc.balanceOf(address(deposits)) == 12_345_678, "deposits funded");
    }

    function testDepositForWithIdPreventsDuplicates() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);
        operator.acceptBuyerOperator(buyer, 1, "");

        operator.depositForWithId(buyer, 1_000_000, "tx:1");
        require(deposits.available(buyer) == 1_000_000, "funded once");

        bool ok;
        try operator.depositForWithId(buyer, 1_000_000, "tx:1") {
            ok = true;
        } catch {
            ok = false;
        }
        require(!ok, "duplicate id rejected");
    }

    function testWithdrawDepositedForSendsRecipient() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        operator.acceptBuyerOperator(buyer, 1, "");
        operator.depositFor(buyer, 12_345_678);
        operator.withdrawDepositedFor(buyer, 2_345_678, recipient);

        require(deposits.available(buyer) == 10_000_000, "buyer debited");
        require(usdc.balanceOf(recipient) == 2_345_678, "recipient credited");
    }

    function testDepositRevertsIfOperatorNotSet() public {
        setUp();
        usdc.mint(address(operator), 100_000_000);

        bool ok;
        try operator.depositFor(buyer, 1_000_000) {
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

        operator.requestClose(channelId);
        operator.withdrawChannel(channelId);

        OperatorCaller buyerCaller = new OperatorCaller(operator);
        channels.setChannelBuyer(channelId, address(buyerCaller));
        require(buyerCaller.callRequestClose(channelId), "buyer can request close");
        require(buyerCaller.callWithdrawChannel(channelId), "buyer can withdraw");

        OperatorCaller outsider = new OperatorCaller(operator);
        channels.setChannelBuyer(channelId, buyer);
        require(!outsider.callRequestClose(channelId), "outsider blocked close");
        require(!outsider.callWithdrawChannel(channelId), "outsider blocked withdraw");
    }
}
