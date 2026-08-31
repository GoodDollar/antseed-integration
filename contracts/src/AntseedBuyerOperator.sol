// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function approve(address spender, uint256 amount) external returns (bool);

    function balanceOf(address account) external view returns (uint256);
}

import {IAntseedChannels} from "./interfaces/IAntseedChannels.sol";
import {IAntseedDeposits} from "./interfaces/IAntseedDeposits.sol";
import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";

contract AntseedBuyerOperator is Initializable, UUPSUpgradeable {
    IAntseedRegistry public immutable registry;
    IERC20 public immutable usdc;

    address public admin;
    address public owner;
    bool private locked;
    mapping(bytes32 => bool) public usedDepositIds;
    mapping(address => uint256) public totalPrincipalDeposited;
    mapping(address => uint256) public totalBonusDeposited;
    mapping(address => uint256) public totalPrincipalWithdrawn;

    bytes32 public DOMAIN_SEPARATOR;

    mapping(address => uint256) public totalBonusWithdrawn;
    mapping(address => uint256) public principalRemaining;
    mapping(address => uint256) public bonusRemaining;
    mapping(address => uint256) public lastAccountedBalance;
    mapping(address => bool) public buyerAccountingMigrated;
    mapping(address => uint256) public usedNonces;

    uint256[50] private __gap;

    bytes32 public constant WITHDRAW_TYPEHASH = keccak256("WithdrawPrincipal(address buyer,uint256 amount,address recipient,uint256 nonce)");
    bytes32 public constant REQUEST_CLOSE_TYPEHASH = keccak256("RequestClose(bytes32 channelId,uint256 nonce)");
    bytes32 public constant WITHDRAW_CHANNEL_TYPEHASH = keccak256("WithdrawChannel(bytes32 channelId,uint256 nonce)");
    bytes32 public constant REVOKE_OPERATOR_TYPEHASH = keccak256("RevokeOperator(address buyer,uint256 nonce)");

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event BuyerOperatorAccepted(address indexed buyer, uint256 nonce);
    event BuyerDepositFunded(address indexed buyer, uint256 principal, uint256 bonus);
    event BuyerDepositFundedWithId(address indexed buyer, uint256 principal, uint256 bonus, string id);
    event BuyerDepositWithdrawn(address indexed buyer, address indexed recipient, uint256 amount);
    event BuyerPrincipalWithdrawn(address indexed buyer, address indexed recipient, uint256 amount);
    event BuyerBonusWithdrawn(address indexed buyer, uint256 amount);
    event BuyerAccountingMigrated(address indexed buyer, uint256 principalRemaining, uint256 bonusRemaining, uint256 accountedBalance);
    event BuyerOperatorRevoked(address indexed buyer);
    event BuyerOperatorTransferred(address indexed buyer, address indexed newOperator);
    event ChannelCloseRequested(bytes32 indexed channelId, address indexed buyer, address indexed caller);
    event ChannelWithdrawn(bytes32 indexed channelId, address indexed buyer, address indexed caller);
    event TokenSwept(address indexed token, address indexed recipient, uint256 amount);

    error NotOwner();
    error InvalidAddress();
    error InvalidAmount();
    error NotBuyerOrAdmin();
    error NotDepositsOperator();
    error TransferFailed();
    error ApproveFailed();
    error DuplicateDepositId();
    error InsufficientPrincipal();
    error InvalidSignature();
    error InvalidNonce();
    error AlreadyMigrated();
    error CloseChannelsBeforeRevoke(uint256 reserved);

    modifier onlyAdmin() {
        if (msg.sender != admin && msg.sender != owner) revert NotOwner();
        _;
    }

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

        registry = IAntseedRegistry(_registry);

        address depositsAddress = registry.deposits();
        if (depositsAddress == address(0) || registry.channels() == address(0)) revert InvalidAddress();

        usdc = IERC20(IAntseedDeposits(depositsAddress).usdc());

        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        if (owner_ == address(0)) revert InvalidAddress();
        admin = owner_;
        owner = owner_;
        emit AdminTransferred(address(0), owner_);
        emit OwnershipTransferred(address(0), owner_);

        address depositsAddress = registry.deposits();
        _forceApprove(usdc, depositsAddress, type(uint256).max);

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AntseedBuyerOperator"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    function acceptBuyerOperator(address buyer, uint256 nonce, bytes calldata buyerSig) external nonReentrant onlyAdmin {
        if (buyer == address(0)) revert InvalidAddress();
        _deposits().setOperator(buyer, address(this), nonce, buyerSig);
        emit BuyerOperatorAccepted(buyer, nonce);
    }

    function _accountForUsage(address buyer) internal {
        (uint256 available, uint256 reserved, ) = _deposits().getBuyerBalance(buyer);
        uint256 currentBalance = available + reserved;
        uint256 previousBalance = lastAccountedBalance[buyer];

        if (previousBalance > currentBalance) {
            uint256 used = previousBalance - currentBalance;
            uint256 principalUsed = _min(used, principalRemaining[buyer]);
            principalRemaining[buyer] -= principalUsed;
            used -= principalUsed;

            if (used > 0) {
                bonusRemaining[buyer] -= _min(used, bonusRemaining[buyer]);
            }
        }

        lastAccountedBalance[buyer] = currentBalance;
    }

    function _recordDeposit(address buyer, uint256 principal, uint256 bonus) internal {
        _accountForUsage(buyer);
        totalPrincipalDeposited[buyer] += principal;
        totalBonusDeposited[buyer] += bonus;
        principalRemaining[buyer] += principal;
        bonusRemaining[buyer] += bonus;
        lastAccountedBalance[buyer] += principal + bonus;
    }

    function depositFor(address buyer, uint256 principal, uint256 bonus) external nonReentrant onlyAdmin {
        if (buyer == address(0)) revert InvalidAddress();
        //revoke bonus if we are not operators
        if (_deposits().getOperator(buyer) != address(this)) bonus = 0;
        uint256 total = principal + bonus;
        if (total == 0) revert InvalidAmount();

        _recordDeposit(buyer, principal, bonus);
        _deposits().deposit(buyer, total);
        emit BuyerDepositFunded(buyer, principal, bonus);
    }

    function depositForWithId(address buyer, uint256 principal, uint256 bonus, string calldata id) external nonReentrant onlyAdmin {
        if (buyer == address(0)) revert InvalidAddress();
        //revoke bonus if we are not operators
        if (_deposits().getOperator(buyer) != address(this)) bonus = 0;
        uint256 total = principal + bonus;
        if (total == 0) revert InvalidAmount();
        bytes32 idHash = keccak256(bytes(id));
        if (usedDepositIds[idHash]) revert DuplicateDepositId();
        usedDepositIds[idHash] = true;

        _recordDeposit(buyer, principal, bonus);
        _deposits().deposit(buyer, total);
        emit BuyerDepositFundedWithId(buyer, principal, bonus, id);
    }

    /// @notice Withdraws principal on behalf of a buyer, authorized by their EIP-712 signature.
    /// @param buyer The buyer whose principal is being withdrawn.
    /// @param amount The amount in USDC micro-units to withdraw.
    /// @param recipient The address to receive the withdrawn USDC.
    /// @param buyerSig The buyer's EIP-712 signature authorizing this withdrawal.
    function withdrawPrincipal(address buyer, uint256 amount, address recipient, uint256 nonce, bytes calldata buyerSig) external nonReentrant {
        if (buyer == address(0) || recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (nonce != usedNonces[buyer]) revert InvalidNonce();

        bytes32 structHash = keccak256(abi.encode(WITHDRAW_TYPEHASH, buyer, amount, recipient, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address signer = ECDSA.recoverCalldata(digest, buyerSig);
        if (signer == address(0) || signer != buyer) revert InvalidSignature();
        usedNonces[buyer] = nonce + 1;

        _requireDepositsOperator(buyer);
        _accountForUsage(buyer);

        if (amount > withdrawablePrincipal(buyer)) revert InsufficientPrincipal();

        uint256 beforeBalance = usdc.balanceOf(address(this));
        _deposits().withdraw(buyer, amount);
        uint256 received = usdc.balanceOf(address(this)) - beforeBalance;
        if (received < amount) revert InvalidAmount();

        principalRemaining[buyer] -= amount;
        totalPrincipalWithdrawn[buyer] += amount;
        lastAccountedBalance[buyer] -= amount;

        _safeTransfer(usdc, recipient, amount);
        emit BuyerPrincipalWithdrawn(buyer, recipient, amount);
    }

    /// @notice Returns the amount of principal a buyer can still withdraw.
    function withdrawablePrincipal(address buyer) public view returns (uint256) {
        (uint256 available, uint256 reserved, ) = _deposits().getBuyerBalance(buyer);
        uint256 remaining = principalRemaining[buyer];
        uint256 currentBalance = available + reserved;
        uint256 previousBalance = lastAccountedBalance[buyer];

        if (previousBalance > currentBalance) {
            uint256 used = previousBalance - currentBalance;
            remaining = used > remaining ? 0 : remaining - used;
        }

        return _min(remaining, available);
    }

    function _withdrawUnusedBonus(address buyer) internal returns (uint256 amount) {
        _accountForUsage(buyer);
        (uint256 available, , ) = _deposits().getBuyerBalance(buyer);
        if (available <= principalRemaining[buyer]) return 0;

        amount = _min(available - principalRemaining[buyer], bonusRemaining[buyer]);
        if (amount == 0) return 0;

        uint256 beforeBalance = usdc.balanceOf(address(this));
        _deposits().withdraw(buyer, amount);
        uint256 received = usdc.balanceOf(address(this)) - beforeBalance;
        if (received < amount) revert InvalidAmount();

        bonusRemaining[buyer] -= amount;
        totalBonusWithdrawn[buyer] += amount;
        lastAccountedBalance[buyer] -= amount;

        emit BuyerBonusWithdrawn(buyer, amount);
    }

    function _revokeOperator(address buyer) internal {
        _requireDepositsOperator(buyer);
        _withdrawUnusedBonus(buyer);
        (, uint256 reserved, ) = _deposits().getBuyerBalance(buyer);
        if (bonusRemaining[buyer] != 0 && reserved > 0) revert CloseChannelsBeforeRevoke(reserved);

        _deposits().transferOperator(buyer, address(0));
        emit BuyerOperatorRevoked(buyer);
    }

    function revokeOperator(address buyer, uint256 nonce, bytes memory buyerSig) public nonReentrant {
        if (buyerSig.length > 0) {
            if (nonce != usedNonces[buyer]) revert InvalidNonce();
            bytes32 structHash = keccak256(abi.encode(REVOKE_OPERATOR_TYPEHASH, buyer, nonce));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
            address signer = ECDSA.recover(digest, buyerSig);
            if (signer == address(0) || signer != buyer) revert InvalidSignature();
            usedNonces[buyer] = nonce + 1;
        } else {
            _requireBuyerOrAdmin(buyer);
        }
        _revokeOperator(buyer);
    }

    function revokeOperator(address buyer) external {
        revokeOperator(buyer, 0, "");
    }

    function _migrateBuyerAccounting(address buyer) internal {
        if (buyer == address(0)) revert InvalidAddress();
        if (buyerAccountingMigrated[buyer]) revert AlreadyMigrated();

        (uint256 available, uint256 reserved, ) = _deposits().getBuyerBalance(buyer);
        uint256 currentBalance = available + reserved;

        uint256 principal = totalPrincipalDeposited[buyer] - totalPrincipalWithdrawn[buyer];
        uint256 bonus = totalBonusDeposited[buyer] - totalBonusWithdrawn[buyer];
        uint256 totalTracked = principal + bonus;

        if (totalTracked > currentBalance) {
            uint256 used = totalTracked - currentBalance;
            uint256 principalUsed = _min(used, principal);
            principal -= principalUsed;
            used -= principalUsed;

            if (used > 0) {
                bonus -= _min(used, bonus);
            }
        }

        principalRemaining[buyer] = principal;
        bonusRemaining[buyer] = bonus;
        lastAccountedBalance[buyer] = currentBalance;
        buyerAccountingMigrated[buyer] = true;

        emit BuyerAccountingMigrated(buyer, principal, bonus, currentBalance);
    }

    /// @notice One-time migration helper for a single buyer funded before remaining-balance accounting existed.
    /// @dev Computes remaining principal/bonus from tracked totals and current deposit balance.
    function migrateBuyerAccounting(address buyer) external onlyAdmin {
        _migrateBuyerAccounting(buyer);
    }

    /// @notice One-time migration helper for multiple buyers funded before remaining-balance accounting existed.
    /// @dev Reverts if any buyer is invalid or already migrated.
    function migrateBuyerAccounting(address[] calldata buyers) external onlyAdmin {
        uint256 len = buyers.length;
        for (uint256 i = 0; i < len; i++) {
            _migrateBuyerAccounting(buyers[i]);
        }
    }

    /// @notice Transfers the operator role for a buyer to a new operator address. without enforcing any bonus withdrawal or channel closure. This function is intended for administrative use only.
    /// @param buyer The address of the buyer whose operator role is being transferred.
    /// @param newOperator The address of the new operator to be assigned to the buyer.
    function transferBuyerOperator(address buyer, address newOperator) external nonReentrant onlyAdmin {
        if (buyer == address(0)) revert InvalidAddress();
        _withdrawUnusedBonus(buyer);
        _deposits().transferOperator(buyer, newOperator);
        emit BuyerOperatorTransferred(buyer, newOperator);
    }

    function requestClose(bytes32 channelId, uint256 nonce, bytes memory buyerSig) public nonReentrant {
        address buyer = _channelBuyer(channelId);
        if (buyerSig.length > 0) {
            if (nonce != usedNonces[buyer]) revert InvalidNonce();
            bytes32 structHash = keccak256(abi.encode(REQUEST_CLOSE_TYPEHASH, channelId, nonce));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
            address signer = ECDSA.recover(digest, buyerSig);
            if (signer == address(0) || signer != buyer) revert InvalidSignature();
            usedNonces[buyer] = nonce + 1;
        } else {
            _requireBuyerOrAdmin(buyer);
        }
        _channels().requestClose(channelId);
        emit ChannelCloseRequested(channelId, buyer, msg.sender);
    }

    function requestClose(bytes32 channelId) external {
        requestClose(channelId, 0, "");
    }

    function withdrawChannel(bytes32 channelId, uint256 nonce, bytes memory buyerSig) public nonReentrant {
        address buyer = _channelBuyer(channelId);
        if (buyerSig.length > 0) {
            if (nonce != usedNonces[buyer]) revert InvalidNonce();
            bytes32 structHash = keccak256(abi.encode(WITHDRAW_CHANNEL_TYPEHASH, channelId, nonce));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
            address signer = ECDSA.recover(digest, buyerSig);
            if (signer == address(0) || signer != buyer) revert InvalidSignature();
            usedNonces[buyer] = nonce + 1;
        } else {
            _requireBuyerOrAdmin(buyer);
        }
        _channels().withdraw(channelId);
        emit ChannelWithdrawn(channelId, buyer, msg.sender);
    }

    function withdrawChannel(bytes32 channelId) external {
        withdrawChannel(channelId, 0, "");
    }

    function sweepToken(address token, address recipient, uint256 amount) external onlyOwner {
        if (token == address(0) || recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        _safeTransfer(IERC20(token), recipient, amount);
        emit TokenSwept(token, recipient, amount);
    }

    function approveCurrentDeposits() external onlyAdmin {
        _forceApprove(usdc, address(_deposits()), type(uint256).max);
    }

    function _requireDepositsOperator(address buyer) internal view {
        if (_deposits().getOperator(buyer) != address(this)) revert NotDepositsOperator();
    }

    function _requireBuyerOrAdmin(address buyer) internal view {
        if (msg.sender == admin || msg.sender == owner || msg.sender == buyer) return;
        revert NotBuyerOrAdmin();
    }

    function _channelBuyer(bytes32 channelId) internal view returns (address buyer) {
        (buyer, , , , , , , , ) = IAntseedChannelsState(address(_channels())).channels(channelId);
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

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}

interface IAntseedChannelsState {
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
        );
}
