// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedRegistry {
    function deposits() external view returns (address);
    function channels() external view returns (address);
}
