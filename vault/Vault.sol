// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title Vault
 * @dev Manages credit issuance and collateral for AntSeed-powered AI agents
 */
contract Vault is Ownable {
    struct Position {
        uint256 collateral;
        uint256 debt;
        uint256 createdAt;
    }

    IERC20 public collateralToken;
    IERC20 public debtToken; // G$

    uint256 public totalCollateral;
    uint256 public totalDebt;
    uint256 public collateralizationRatioBps; // e.g. 15000 = 150%

    mapping(address => Position) public positions;

    event PositionOpened(address indexed user, uint256 collateral, uint256 debt);
    event PositionAdjusted(address indexed user, int256 collateralDelta, int256 debtDelta);
    event PositionLiquidated(address indexed user, uint256 seizedCollateral, uint256 forgivenDebt);

    constructor(address _collateralToken, address _debtToken, uint256 _collateralizationRatioBps) Ownable(msg.sender) {
        collateralToken = IERC20(_collateralToken);
        debtToken = IERC20(_debtToken);
        collateralizationRatioBps = _collateralizationRatioBps;
    }

    function openPosition(uint256 collateralAmount, uint256 debtAmount) external {
        require(collateralAmount > 0, "Vault: collateral required");
        require(debtAmount > 0, "Vault: debt required");
        
        Position storage position = positions[msg.sender];
        require(position.debt == 0, "Vault: position exists");

        uint256 requiredCollateral = (debtAmount * 10000) / collateralizationRatioBps;
        require(collateralAmount >= requiredCollateral, "Vault: insufficient collateral");

        require(collateralToken.transferFrom(msg.sender, address(this), collateralAmount), "Vault: transfer failed");
        
        position.collateral = collateralAmount;
        position.debt = debtAmount;
        position.createdAt = block.timestamp;

        totalCollateral += collateralAmount;
        totalDebt += debtAmount;

        emit PositionOpened(msg.sender, collateralAmount, debtAmount);
    }

    function adjustPosition(int256 collateralDelta, int256 debtDelta) external {
        Position storage position = positions[msg.sender];
        require(position.debt > 0, "Vault: no position");

        if (collateralDelta > 0) {
            require(collateralToken.transferFrom(msg.sender, address(this), uint256(collateralDelta)), "Vault: transfer failed");
            position.collateral += uint256(collateralDelta);
            totalCollateral += uint256(collateralDelta);
        } else if (collateralDelta < 0) {
            uint256 withdrawAmount = uint256(-collateralDelta);
            require(withdrawAmount <= position.collateral, "Vault: over-withdraw");
            require(collateralToken.transfer(msg.sender, withdrawAmount), "Vault: transfer failed");
            position.collateral -= withdrawAmount;
            totalCollateral -= withdrawAmount;
        }

        if (debtDelta > 0) {
            position.debt += uint256(debtDelta);
            totalDebt += uint256(debtDelta);
        } else if (debtDelta < 0) {
            uint256 repayAmount = uint256(-debtDelta);
            require(repayAmount <= position.debt, "Vault: over-repay");
            position.debt -= repayAmount;
            totalDebt -= repayAmount;
        }

        emit PositionAdjusted(msg.sender, collateralDelta, debtDelta);
    }

    function liquidate(address user) external {
        Position storage position = positions[user];
        require(position.debt > 0, "Vault: no position");
        
        uint256 currentRatioBps = (position.collateral * 10000) / position.debt;
        require(currentRatioBps < collateralizationRatioBps, "Vault: position healthy");

        uint256 seizedCollateral = position.collateral;
        uint256 forgivenDebt = position.debt;

        totalCollateral -= seizedCollateral;
        totalDebt -= forgivenDebt;

        position.collateral = 0;
        position.debt = 0;

        require(collateralToken.transfer(msg.sender, seizedCollateral), "Vault: transfer failed");

        emit PositionLiquidated(user, seizedCollateral, forgivenDebt);
    }

    function setCollateralizationRatio(uint256 newRatioBps) external onlyOwner {
        require(newRatioBps >= 10000, "Vault: ratio too low");
        collateralizationRatioBps = newRatioBps;
    }
}