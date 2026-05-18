// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ISuperfluidHostLike {
    function registerApp(uint256 configWord) external;
}

interface IConstantFlowAgreementV1Like {
    function getFlow(address token, address sender, address receiver)
        external
        view
        returns (uint256 timestamp, int96 flowRate, uint256 deposit, uint256 owedDeposit);
}

/// @title CeloGdAntSeedVault
/// @notice Celo-side G$ vault for AntSeed credits. No bridge logic is included.
/// @dev Accepts direct ERC-20 deposits, ERC677/667 transferAndCall callbacks, ERC777 callbacks,
///      and Superfluid SuperApp stream callbacks. Backend converts G$ events into USDC-denominated credits.
contract CeloGdAntSeedVault {
    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error UnsupportedToken();
    error UnsupportedAgreement();
    error NotGoodIDVerified();
    error NotSuperfluidHost();
    error WrongReceiver();
    error NegativeFlowRate();
    error TransferFailed();

    IERC20Like public immutable gdToken;
    address public immutable gdSuperToken;
    address public owner;
    address public goodIdVerifier;
    address public superfluidHost;
    address public cfaV1;

    mapping(address => uint256) public totalDepositedGd;
    mapping(address => int96) public streamFlowRate;
    mapping(address => uint256) public streamMonthlyGdAmount;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event GoodIDVerifierUpdated(address indexed verifier);
    event SuperfluidConfigUpdated(address indexed host, address indexed cfaV1);
    event GdDeposited(address indexed account, address indexed payer, uint256 gdAmount, bytes data);
    event StreamUpdated(address indexed account, int96 flowRate, uint256 monthlyGdAmountWei);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyGdToken() {
        if (msg.sender != address(gdToken)) revert UnsupportedToken();
        _;
    }

    modifier onlySuperfluidHost() {
        if (msg.sender != superfluidHost) revert NotSuperfluidHost();
        _;
    }

    constructor(address gdToken_, address gdSuperToken_, address goodIdVerifier_, address superfluidHost_, address cfaV1_) {
        if (gdToken_ == address(0) || goodIdVerifier_ == address(0)) revert ZeroAddress();
        gdToken = IERC20Like(gdToken_);
        gdSuperToken = gdSuperToken_;
        goodIdVerifier = goodIdVerifier_;
        superfluidHost = superfluidHost_;
        cfaV1 = cfaV1_;
        owner = msg.sender;

        emit OwnershipTransferred(address(0), msg.sender);
        emit GoodIDVerifierUpdated(goodIdVerifier_);
        emit SuperfluidConfigUpdated(superfluidHost_, cfaV1_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setGoodIdVerifier(address verifier) external onlyOwner {
        if (verifier == address(0)) revert ZeroAddress();
        goodIdVerifier = verifier;
        emit GoodIDVerifierUpdated(verifier);
    }

    function setSuperfluidConfig(address host, address agreement) external onlyOwner {
        superfluidHost = host;
        cfaV1 = agreement;
        emit SuperfluidConfigUpdated(host, agreement);
    }

    /// @notice Optional registration helper for deployments that want the vault registered as a SuperApp.
    /// @dev The config word is intentionally supplied by deployment scripts because Superfluid app level
    ///      and callback noop bitmap are network/version specific.
    function registerSuperApp(uint256 configWord) external onlyOwner {
        if (superfluidHost == address(0)) revert ZeroAddress();
        ISuperfluidHostLike(superfluidHost).registerApp(configWord);
    }

    /// @notice Classic ERC-20 deposit path. ERC677/777 callbacks below provide single-transaction deposits.
    function deposit(uint256 amount, bytes calldata data) external returns (uint256) {
        if (amount == 0) revert ZeroAmount();
        _requireVerified(msg.sender);
        totalDepositedGd[msg.sender] += amount;
        _safeTransferFrom(msg.sender, address(this), amount);
        emit GdDeposited(msg.sender, msg.sender, amount, data);
        return totalDepositedGd[msg.sender];
    }

    /// @notice ERC677 / ERC667 transferAndCall receiver.
    function onTokenTransfer(address from, uint256 amount, bytes calldata data) external onlyGdToken returns (bool) {
        _recordTokenCallbackDeposit(from, from, amount, data);
        return true;
    }

    /// @notice Legacy ERC223/ERC667-style token fallback receiver used by some token implementations.
    function tokenFallback(address from, uint256 amount, bytes calldata data) external onlyGdToken {
        _recordTokenCallbackDeposit(from, from, amount, data);
    }

    /// @notice ERC777 tokensReceived hook. Register this implementer in ERC1820 when using ERC777 delivery.
    function tokensReceived(
        address operator,
        address from,
        address to,
        uint256 amount,
        bytes calldata userData,
        bytes calldata
    ) external onlyGdToken {
        if (to != address(this)) revert WrongReceiver();
        _recordTokenCallbackDeposit(from, operator, amount, userData);
    }

    function afterAgreementCreated(
        address superToken,
        address agreementClass,
        bytes32,
        bytes calldata agreementData,
        bytes calldata,
        bytes calldata ctx
    ) external onlySuperfluidHost returns (bytes memory newCtx) {
        _recordStream(superToken, agreementClass, agreementData, true);
        return ctx;
    }

    function afterAgreementUpdated(
        address superToken,
        address agreementClass,
        bytes32,
        bytes calldata agreementData,
        bytes calldata,
        bytes calldata ctx
    ) external onlySuperfluidHost returns (bytes memory newCtx) {
        _recordStream(superToken, agreementClass, agreementData, true);
        return ctx;
    }

    function afterAgreementTerminated(
        address superToken,
        address agreementClass,
        bytes32,
        bytes calldata agreementData,
        bytes calldata,
        bytes calldata ctx
    ) external onlySuperfluidHost returns (bytes memory newCtx) {
        // Do not block stream termination if the user later lost GoodID status.
        _recordStream(superToken, agreementClass, agreementData, false);
        return ctx;
    }

    function isGoodIDVerified(address account) public view returns (bool) {
        (bool ok, bytes memory result) = goodIdVerifier.staticcall(abi.encodeWithSignature("isWhitelisted(address)", account));
        if (ok && result.length >= 32 && abi.decode(result, (bool))) return true;

        (ok, result) = goodIdVerifier.staticcall(abi.encodeWithSignature("getWhitelistedRoot(address)", account));
        if (ok && result.length >= 32 && abi.decode(result, (address)) != address(0)) return true;

        return false;
    }

    function _recordTokenCallbackDeposit(address account, address payer, uint256 amount, bytes calldata data) private {
        if (amount == 0) revert ZeroAmount();
        _requireVerified(account);
        totalDepositedGd[account] += amount;
        emit GdDeposited(account, payer, amount, data);
    }

    function _recordStream(address superToken, address agreementClass, bytes calldata agreementData, bool enforceGoodID) private {
        if (superToken != gdSuperToken) revert UnsupportedToken();
        if (agreementClass != cfaV1) revert UnsupportedAgreement();

        (address sender, address receiver) = abi.decode(agreementData, (address, address));
        if (receiver != address(this)) revert WrongReceiver();
        if (enforceGoodID) _requireVerified(sender);

        (, int96 flowRate,,) = IConstantFlowAgreementV1Like(cfaV1).getFlow(superToken, sender, address(this));
        if (flowRate < 0) revert NegativeFlowRate();

        streamFlowRate[sender] = flowRate;
        uint256 monthlyAmount = uint256(uint96(flowRate)) * 30 days;
        streamMonthlyGdAmount[sender] = monthlyAmount;
        emit StreamUpdated(sender, flowRate, monthlyAmount);
    }

    function _requireVerified(address account) private view {
        if (!isGoodIDVerified(account)) revert NotGoodIDVerified();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(gdToken).call(abi.encodeWithSelector(IERC20Like.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
