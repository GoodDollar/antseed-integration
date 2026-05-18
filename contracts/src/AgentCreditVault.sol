// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title AgentCreditVault
/// @notice ERC-20 prepaid-credit vault for AntSeed-backed agent compute.
/// @dev The backend/operator reserves and settles request costs; the contract only enforces accounting.
contract AgentCreditVault {
    error NotOwner();
    error NotOperator();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientAvailable();
    error RequestAlreadyExists();
    error UnknownRequest();
    error RequestAlreadySettled();
    error ActualCostTooHigh();
    error TransferFailed();

    enum RequestStatus {
        None,
        Reserved,
        Settled,
        Released
    }

    struct RequestCredit {
        address account;
        uint256 reservedAmount;
        uint256 settledAmount;
        RequestStatus status;
        bytes32 metadataHash;
    }

    IERC20 public immutable token;
    address public owner;
    address public treasury;

    mapping(address => bool) public operators;
    mapping(address => uint256) public balances;
    mapping(address => uint256) public reservedBalances;
    mapping(bytes32 => RequestCredit) public requests;

    bool private locked;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event OperatorUpdated(address indexed operator, bool enabled);
    event Deposited(address indexed payer, address indexed account, uint256 amount);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    event CreditReserved(bytes32 indexed requestId, address indexed account, uint256 amount, bytes32 metadataHash);
    event CreditSettled(bytes32 indexed requestId, address indexed account, uint256 actualCost, uint256 refundedAmount, bytes32 providerReceiptHash);
    event CreditReleased(bytes32 indexed requestId, address indexed account, uint256 amount);

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

    constructor(IERC20 token_, address treasury_) {
        if (address(token_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        token = token_;
        owner = msg.sender;
        treasury = treasury_;
        operators[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit TreasuryUpdated(address(0), treasury_);
        emit OperatorUpdated(msg.sender, true);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setOperator(address operator, bool enabled) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        operators[operator] = enabled;
        emit OperatorUpdated(operator, enabled);
    }

    function availableBalance(address account) public view returns (uint256) {
        return balances[account] - reservedBalances[account];
    }

    function deposit(uint256 amount) external returns (uint256) {
        return depositFor(msg.sender, amount);
    }

    function depositFor(address account, uint256 amount) public nonReentrant returns (uint256) {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        balances[account] += amount;
        _safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, account, amount);
        return balances[account];
    }

    function withdraw(uint256 amount, address to) external nonReentrant returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (availableBalance(msg.sender) < amount) revert InsufficientAvailable();
        balances[msg.sender] -= amount;
        _safeTransfer(to, amount);
        emit Withdrawn(msg.sender, to, amount);
        return balances[msg.sender];
    }

    function reserve(bytes32 requestId, address account, uint256 amount, bytes32 metadataHash)
        external
        onlyOperator
        returns (uint256)
    {
        if (requestId == bytes32(0) || account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (requests[requestId].status != RequestStatus.None) revert RequestAlreadyExists();
        if (availableBalance(account) < amount) revert InsufficientAvailable();

        reservedBalances[account] += amount;
        requests[requestId] = RequestCredit({
            account: account,
            reservedAmount: amount,
            settledAmount: 0,
            status: RequestStatus.Reserved,
            metadataHash: metadataHash
        });

        emit CreditReserved(requestId, account, amount, metadataHash);
        return reservedBalances[account];
    }

    function settle(bytes32 requestId, uint256 actualCost, bytes32 providerReceiptHash)
        external
        onlyOperator
        nonReentrant
        returns (uint256 refundedAmount)
    {
        RequestCredit storage req = requests[requestId];
        if (req.status == RequestStatus.None) revert UnknownRequest();
        if (req.status != RequestStatus.Reserved) revert RequestAlreadySettled();
        if (actualCost > req.reservedAmount) revert ActualCostTooHigh();

        refundedAmount = req.reservedAmount - actualCost;
        reservedBalances[req.account] -= req.reservedAmount;
        balances[req.account] -= actualCost;
        req.settledAmount = actualCost;
        req.status = RequestStatus.Settled;

        if (actualCost > 0) _safeTransfer(treasury, actualCost);
        emit CreditSettled(requestId, req.account, actualCost, refundedAmount, providerReceiptHash);
    }

    function release(bytes32 requestId) external onlyOperator returns (uint256 releasedAmount) {
        RequestCredit storage req = requests[requestId];
        if (req.status == RequestStatus.None) revert UnknownRequest();
        if (req.status != RequestStatus.Reserved) revert RequestAlreadySettled();

        releasedAmount = req.reservedAmount;
        reservedBalances[req.account] -= releasedAmount;
        req.status = RequestStatus.Released;

        emit CreditReleased(requestId, req.account, releasedAmount);
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
