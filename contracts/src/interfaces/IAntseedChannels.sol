// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedChannels {
    function requestClose(bytes32 channelId) external;
    function withdraw(bytes32 channelId) external;
}
