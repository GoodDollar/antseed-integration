// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentCreditVault, IERC20} from "../src/AgentCreditVault.sol";

contract TestToken is IERC20 {
    string public name = "Test USD";
    string public symbol = "tUSD";
    uint8 public decimals = 6;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
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

contract UserProxy {
    TestToken public token;
    AgentCreditVault public vault;

    constructor(TestToken token_, AgentCreditVault vault_) {
        token = token_;
        vault = vault_;
    }

    function deposit(uint256 amount) external {
        token.approve(address(vault), amount);
        vault.deposit(amount);
    }

    function withdraw(uint256 amount, address to) external {
        vault.withdraw(amount, to);
    }
}

contract AgentCreditVaultTest {
    TestToken token;
    AgentCreditVault vault;
    UserProxy user;
    address treasury = address(0xCAFE);

    function setUp() public {
        token = new TestToken();
        vault = new AgentCreditVault(IERC20(address(token)), treasury);
        user = new UserProxy(token, vault);
        token.mint(address(user), 100_000_000);
        user.deposit(100_000_000);
    }

    function testDepositReserveSettleRefundsUnusedCredit() public {
        setUp();
        bytes32 requestId = keccak256("request-1");

        vault.reserve(requestId, address(user), 10_000_000, keccak256("metadata"));
        require(vault.availableBalance(address(user)) == 90_000_000, "available after reserve");
        require(vault.reservedBalances(address(user)) == 10_000_000, "reserved after reserve");

        uint256 refund = vault.settle(requestId, 4_000_000, keccak256("receipt"));
        require(refund == 6_000_000, "refund");
        require(vault.availableBalance(address(user)) == 96_000_000, "available after settle");
        require(vault.reservedBalances(address(user)) == 0, "reserved after settle");
        require(token.balanceOf(treasury) == 4_000_000, "treasury paid");
    }

    function testReleaseRestoresAvailability() public {
        setUp();
        bytes32 requestId = keccak256("request-2");
        vault.reserve(requestId, address(user), 7_000_000, bytes32(0));
        uint256 released = vault.release(requestId);
        require(released == 7_000_000, "released");
        require(vault.availableBalance(address(user)) == 100_000_000, "available restored");
    }

    function testWithdrawAvailableOnly() public {
        setUp();
        vault.reserve(keccak256("request-3"), address(user), 80_000_000, bytes32(0));
        user.withdraw(20_000_000, address(0xBEEF));
        require(token.balanceOf(address(0xBEEF)) == 20_000_000, "withdrawn");
        require(vault.availableBalance(address(user)) == 0, "none available");
    }
}
