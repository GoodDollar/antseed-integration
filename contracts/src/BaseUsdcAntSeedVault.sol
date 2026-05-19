// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IAntSeedDeposits {
    function deposit(address buyer, uint256 amount) external;
    function getBuyerBalance(address buyer) external view returns (uint256 available, uint256 reserved, uint256 lastActivityAt);
}

/// @title BaseUsdcAntSeedVault
/// @notice Backend-controlled USDC funding vault for the GoodDollar -> AntSeed MVP.
/// @dev Users do not receive withdrawable USDC balances here. Users deposit G$ on Celo, the backend credits
///      an internal ledger, and this vault funds a single backend/operator AntSeed buyer address on Base.
contract BaseUsdcAntSeedVault {
    error NotOwner();
    error NotOperator();
    error ZeroAddress();
    error ZeroAmount();
    error TransferFailed();
    error ApproveFailed();

    IERC20Like public immutable usdc;
    IAntSeedDeposits public antSeedDeposits;
    address public antSeedBuyer;
    address public owner;
    mapping(address => bool) public operators;
    bool private locked;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorUpdated(address indexed operator, bool enabled);
    event AntSeedRouteUpdated(address indexed depositsContract, address indexed buyer);
    event Deposited(address indexed payer, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event AntSeedDepositFunded(address indexed operator, address indexed buyer, address indexed depositsContract, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert NotOperator();
        _;
    }

    modifier nonReentrant() {
        require(!locked, "REENTRANT");
        locked = true;
        _;
        locked = false;
    }

    constructor(IERC20Like usdc_, IAntSeedDeposits antSeedDeposits_, address antSeedBuyer_) {
        if (address(usdc_) == address(0) || address(antSeedDeposits_) == address(0) || antSeedBuyer_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = usdc_;
        antSeedDeposits = antSeedDeposits_;
        antSeedBuyer = antSeedBuyer_;
        owner = msg.sender;
        operators[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit OperatorUpdated(msg.sender, true);
        emit AntSeedRouteUpdated(address(antSeedDeposits_), antSeedBuyer_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setOperator(address operator, bool enabled) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        operators[operator] = enabled;
        emit OperatorUpdated(operator, enabled);
    }

    function setAntSeedRoute(IAntSeedDeposits depositsContract, address buyer) external onlyOwner {
        if (address(depositsContract) == address(0) || buyer == address(0)) revert ZeroAddress();
        antSeedDeposits = depositsContract;
        antSeedBuyer = buyer;
        emit AntSeedRouteUpdated(address(depositsContract), buyer);
    }

    function balance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function antSeedBuyerBalance() external view returns (uint256 available, uint256 reserved, uint256 lastActivityAt) {
        return antSeedDeposits.getBuyerBalance(antSeedBuyer);
    }

    function deposit(uint256 amount) external nonReentrant returns (uint256) {
        if (amount == 0) revert ZeroAmount();
        _safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
        return usdc.balanceOf(address(this));
    }

    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _safeTransfer(to, amount);
        emit Withdrawn(to, amount);
        return usdc.balanceOf(address(this));
    }

    /// @notice Move USDC from this backend-controlled vault into AntSeed's deposit contract for the backend buyer.
    /// @dev AntSeed's deposits contract pulls USDC from msg.sender and credits `antSeedBuyer`; users never get a
    ///      withdrawable AntSeed USDC balance in this MVP.
    function fundAntSeedDeposit(uint256 amount) external onlyOperator nonReentrant returns (uint256 availableAfter) {
        if (amount == 0) revert ZeroAmount();
        address depositsAddress = address(antSeedDeposits);
        _safeApprove(depositsAddress, 0);
        _safeApprove(depositsAddress, amount);
        antSeedDeposits.deposit(antSeedBuyer, amount);
        _safeApprove(depositsAddress, 0);
        (availableAfter,,) = antSeedDeposits.getBuyerBalance(antSeedBuyer);
        emit AntSeedDepositFunded(msg.sender, antSeedBuyer, depositsAddress, amount);
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(usdc).call(abi.encodeWithSelector(IERC20Like.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(usdc).call(abi.encodeWithSelector(IERC20Like.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeApprove(address spender, uint256 amount) private {
        (bool ok, bytes memory data) = address(usdc).call(abi.encodeWithSelector(IERC20Like.approve.selector, spender, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }
}
