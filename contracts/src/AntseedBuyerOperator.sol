// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

import { IAntseedChannels } from "./interfaces/IAntseedChannels.sol";
import { IAntseedDeposits } from "./interfaces/IAntseedDeposits.sol";
import { IAntseedRegistry } from "./interfaces/IAntseedRegistry.sol";

contract AntseedBuyerOperator {
    IAntseedRegistry public immutable registry;
    IERC20 public immutable usdc;

    address public owner;
    address public pendingOwner;
    bool private locked;
    mapping(bytes32 => bool) public usedDepositIds;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event BuyerOperatorAccepted(address indexed buyer, uint256 nonce);
    event BuyerDepositFunded(address indexed buyer, uint256 amount);
    event BuyerDepositFundedWithId(address indexed buyer, uint256 amount, string id);
    event BuyerDepositWithdrawn(address indexed buyer, address indexed recipient, uint256 amount);
    event BuyerOperatorTransferred(address indexed buyer, address indexed newOperator);
    event ChannelCloseRequested(bytes32 indexed channelId, address indexed buyer, address indexed caller);
    event ChannelWithdrawn(bytes32 indexed channelId, address indexed buyer, address indexed caller);
    event TokenSwept(address indexed token, address indexed recipient, uint256 amount);

    error NotOwner();
    error InvalidAddress();
    error InvalidAmount();
    error NotBuyerOrOwner();
    error NotDepositsOperator();
    error TransferFailed();
    error ApproveFailed();
    error DuplicateDepositId();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        require(!locked, "REENTRANT");
        locked = true;
        _;
        locked = false;
    }

    constructor(address _registry) {
        if (_registry == address(0)) revert InvalidAddress();

        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);

        registry = IAntseedRegistry(_registry);

        address depositsAddress = registry.deposits();
        if (depositsAddress == address(0) || registry.channels() == address(0)) revert InvalidAddress();

        usdc = IERC20(IAntseedDeposits(depositsAddress).usdc());
        _forceApprove(usdc, depositsAddress, type(uint256).max);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    function acceptBuyerOperator(address buyer, uint256 nonce, bytes calldata buyerSig) external nonReentrant onlyOwner {
        if (buyer == address(0)) revert InvalidAddress();
        _deposits().setOperator(buyer, address(this), nonce, buyerSig);
        emit BuyerOperatorAccepted(buyer, nonce);
    }

    function depositFor(address buyer, uint256 amount) external nonReentrant onlyOwner {
        if (buyer == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        _requireDepositsOperator(buyer);

        _deposits().deposit(buyer, amount);
        emit BuyerDepositFunded(buyer, amount);
    }

    function depositForWithId(address buyer, uint256 amount, string calldata id) external nonReentrant onlyOwner {
        if (buyer == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        bytes32 idHash = keccak256(bytes(id));
        if (usedDepositIds[idHash]) revert DuplicateDepositId();
        usedDepositIds[idHash] = true;
        _requireDepositsOperator(buyer);

        _deposits().deposit(buyer, amount);
        emit BuyerDepositFundedWithId(buyer, amount, id);
    }

    function withdrawDepositedFor(address buyer, uint256 amount, address recipient) external nonReentrant onlyOwner {
        if (buyer == address(0) || recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        _requireDepositsOperator(buyer);

        uint256 beforeBalance = usdc.balanceOf(address(this));
        _deposits().withdraw(buyer, amount);
        uint256 received = usdc.balanceOf(address(this)) - beforeBalance;
        if (received < amount) revert InvalidAmount();

        _safeTransfer(usdc, recipient, amount);
        emit BuyerDepositWithdrawn(buyer, recipient, amount);
    }

    function transferBuyerOperator(address buyer, address newOperator) external nonReentrant onlyOwner {
        if (buyer == address(0)) revert InvalidAddress();
        _deposits().transferOperator(buyer, newOperator);
        emit BuyerOperatorTransferred(buyer, newOperator);
    }

    function requestClose(bytes32 channelId) external nonReentrant {
        address buyer = _channelBuyer(channelId);
        _requireBuyerOrOwner(buyer);
        _channels().requestClose(channelId);
        emit ChannelCloseRequested(channelId, buyer, msg.sender);
    }

    function withdrawChannel(bytes32 channelId) external nonReentrant {
        address buyer = _channelBuyer(channelId);
        _requireBuyerOrOwner(buyer);
        _channels().withdraw(channelId);
        emit ChannelWithdrawn(channelId, buyer, msg.sender);
    }

    function sweepToken(address token, address recipient, uint256 amount) external nonReentrant onlyOwner {
        if (token == address(0) || recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        _safeTransfer(IERC20(token), recipient, amount);
        emit TokenSwept(token, recipient, amount);
    }

    function approveCurrentDeposits() external onlyOwner {
        _forceApprove(usdc, address(_deposits()), type(uint256).max);
    }

    function _requireDepositsOperator(address buyer) internal view {
        if (_deposits().getOperator(buyer) != address(this)) revert NotDepositsOperator();
    }

    function _requireBuyerOrOwner(address buyer) internal view {
        if (msg.sender == owner || msg.sender == buyer) return;
        revert NotBuyerOrOwner();
    }

    function _channelBuyer(bytes32 channelId) internal view returns (address buyer) {
        (buyer,,,,,,,,) = IAntseedChannelsState(address(_channels())).channels(channelId);
        if (buyer == address(0)) revert InvalidAddress();
    }

    function _deposits() internal view returns (IAntseedDeposits deposits_) {
        address depositsAddress = registry.deposits();
        if (depositsAddress == address(0)) revert InvalidAddress();
        deposits_ = IAntseedDeposits(depositsAddress);
    }

    function _channels() internal view returns (IAntseedChannels channels_) {
        address channelsAddress = registry.channels();
        if (channelsAddress == address(0)) revert InvalidAddress();
        channels_ = IAntseedChannels(channelsAddress);
    }

    function _safeTransfer(IERC20 token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeApprove(IERC20 token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }

    function _forceApprove(IERC20 token, address spender, uint256 amount) private {
        _safeApprove(token, spender, 0);
        _safeApprove(token, spender, amount);
    }
}

interface IAntseedChannelsState {
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
        );
}
