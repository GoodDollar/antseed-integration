// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseUsdcAntSeedVault, IERC20Like, IAntSeedDeposits} from "../src/BaseUsdcAntSeedVault.sol";

contract TestUsdc is IERC20Like {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 6;
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

contract MockAntSeedDeposits is IAntSeedDeposits {
    IERC20Like public usdc;
    mapping(address => uint256) public available;
    mapping(address => uint256) public reserved;
    mapping(address => uint256) public lastActivityAt;

    constructor(IERC20Like usdc_) {
        usdc = usdc_;
    }

    function deposit(address buyer, uint256 amount) external override {
        require(usdc.transferFrom(msg.sender, address(this), amount), "TRANSFER_FROM");
        available[buyer] += amount;
        lastActivityAt[buyer] = block.timestamp;
    }

    function getBuyerBalance(address buyer) external view override returns (uint256, uint256, uint256) {
        return (available[buyer], reserved[buyer], lastActivityAt[buyer]);
    }
}

contract BaseUsdcAntSeedVaultTest {
    TestUsdc usdc;
    MockAntSeedDeposits antseed;
    BaseUsdcAntSeedVault vault;
    address buyer = address(0xB0B);
    address operator = address(0x0A11CE);

    function setUp() public {
        usdc = new TestUsdc();
        antseed = new MockAntSeedDeposits(usdc);
        vault = new BaseUsdcAntSeedVault(usdc, antseed, buyer);
        vault.setOperator(operator, true);
        usdc.mint(address(this), 100_000_000);
        usdc.approve(address(vault), 100_000_000);
        vault.deposit(100_000_000);
    }

    function testFundAntSeedDepositCreditsBackendBuyerNotUser() public {
        setUp();

        uint256 availableAfter = vault.fundAntSeedDeposit(12_345_678);

        require(availableAfter == 12_345_678, "available after");
        require(usdc.balanceOf(address(vault)) == 87_654_322, "vault debited");
        require(usdc.balanceOf(address(antseed)) == 12_345_678, "antseed funded");
        (uint256 buyerAvailable,,) = antseed.getBuyerBalance(buyer);
        require(buyerAvailable == 12_345_678, "buyer credited");
        (uint256 randomAvailable,,) = antseed.getBuyerBalance(address(0xCAFE));
        require(randomAvailable == 0, "no per-user balance");
    }

    function testOnlyOperatorCanFund() public {
        setUp();
        NonOperator attacker = new NonOperator(vault);
        bool ok = attacker.tryFund(1_000_000);
        require(!ok, "attacker blocked");
    }
}

contract NonOperator {
    BaseUsdcAntSeedVault public vault;

    constructor(BaseUsdcAntSeedVault vault_) {
        vault = vault_;
    }

    function tryFund(uint256 amount) external returns (bool) {
        try vault.fundAntSeedDeposit(amount) returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }
}
