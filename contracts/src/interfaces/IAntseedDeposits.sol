// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedDeposits {
    function usdc() external view returns (address);
    function setOperator(address buyer, address operator, uint256 nonce, bytes calldata buyerSig) external;
    function deposit(address buyer, uint256 amount) external;
    function withdraw(address buyer, uint256 amount) external;
    function getBuyerBalance(address buyer) external view returns (uint256 available, uint256 reserved, uint256 lastActivity);
    function transferOperator(address buyer, address newOperator) external;
    function getOperator(address buyer) external view returns (address);
}
