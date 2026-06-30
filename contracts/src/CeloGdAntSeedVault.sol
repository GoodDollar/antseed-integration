// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ISuperfluidHostLike {
    struct Context {
        uint8 appCallbackLevel;
        uint8 callType;
        uint256 timestamp;
        address msgSender;
        bytes4 agreementSelector;
        bytes userData;
        uint256 appAllowanceGranted;
        uint256 appAllowanceWanted;
        int256 appAllowanceUsed;
        address appAddress;
        address appAllowanceToken;
    }

    function registerApp(uint256 configWord) external;
    function decodeCtx(bytes calldata ctx) external pure returns (Context memory context);
}

interface IConstantFlowAgreementV1Like {
    function getFlow(address token, address sender, address receiver)
        external
        view
        returns (uint256 timestamp, int96 flowRate, uint256 deposit, uint256 owedDeposit);
}

interface IReservePriceOracleLike {
    function currentPriceDAI() external view returns (uint256);
}

/// @title CeloGdAntSeedVault
/// @notice Celo-side G$ vault for AntSeed credits. No bridge logic is included.
/// @dev Accepts direct ERC-20 deposits, ERC677/667 transferAndCall callbacks, ERC777 callbacks,
///      and Superfluid SuperApp stream callbacks. Backend converts G$ events into USDC-denominated credits.
contract CeloGdAntSeedVault is Initializable, UUPSUpgradeable {
    uint256 private constant MICRO_USD_PER_USD = 1_000_000;
    uint256 private constant RESERVE_PRICE_DECIMALS = 1e18;
    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error UnsupportedToken();
    error UnsupportedAgreement();
    error NotSuperfluidHost();
    error WrongReceiver();
    error NegativeFlowRate();
    error TransferFailed();
    error FirstDepositBelowMinimum();
    error StreamRateBelowMinimum();
    error InvalidPriceConfig();
    error MissingBuyerAddress();

    IERC20Like public immutable gdToken;
    address public owner;
    address public superfluidHost;
    address public cfaV1;
    address public reservePriceOracle;
    uint256 public minFirstDepositMicroUsd;
    uint256 public minMonthlyStreamMicroUsd;
    uint256 public fallbackGdMicroUsdPerToken;

    mapping(address => uint256) public totalDepositedGd;
    mapping(address => int96) public streamFlowRate;
    mapping(address => uint256) public streamMonthlyGdAmount;
    /// @notice AntSeed buyer account funded when stream credits are settled for each sender.
    mapping(address => address) public streamBuyer;

    uint256[50] private __gap;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SuperfluidConfigUpdated(address indexed host, address indexed cfaV1);
    event ReservePriceOracleUpdated(address indexed reservePriceOracle);
    event MinimumsUpdated(uint256 minFirstDepositMicroUsd, uint256 minMonthlyStreamMicroUsd, uint256 fallbackGdMicroUsdPerToken);
    /// @dev `buyer` is the AntSeed buyer account to credit, decoded from the `data` payload (abi.encode(buyerAddress)).
    event GdDeposited(address indexed account, address indexed buyer, uint256 gdAmount, bytes data);
    /// @dev `buyer` is the AntSeed buyer account decoded from Superfluid userdata (abi.encode(buyerAddress)).
    event StreamUpdated(address indexed account, address indexed buyer, int96 flowRate, uint256 monthlyGdAmountWei, uint256 totalFlowWei);

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

    constructor(address gdToken_) {
        if (gdToken_ == address(0)) revert ZeroAddress();
        gdToken = IERC20Like(gdToken_);
        _disableInitializers();
    }

    function initialize(address owner_, address superfluidHost_, address cfaV1_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        superfluidHost = superfluidHost_;
        cfaV1 = cfaV1_;
        minFirstDepositMicroUsd = 1_000_000;
        minMonthlyStreamMicroUsd = 1_000_000;
        fallbackGdMicroUsdPerToken = 1_000_000;

        emit OwnershipTransferred(address(0), owner_);
        emit SuperfluidConfigUpdated(superfluidHost_, cfaV1_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setSuperfluidConfig(address host, address agreement) external onlyOwner {
        superfluidHost = host;
        cfaV1 = agreement;
        emit SuperfluidConfigUpdated(host, agreement);
    }

    function setReserveConfig(address reservePriceOracle_, uint256 fallbackGdMicroUsdPerToken_) external onlyOwner {
        if (reservePriceOracle_ == address(0) && fallbackGdMicroUsdPerToken_ == 0) revert InvalidPriceConfig();
        reservePriceOracle = reservePriceOracle_;
        if (fallbackGdMicroUsdPerToken_ > 0) fallbackGdMicroUsdPerToken = fallbackGdMicroUsdPerToken_;
        emit ReservePriceOracleUpdated(reservePriceOracle_);
        emit MinimumsUpdated(minFirstDepositMicroUsd, minMonthlyStreamMicroUsd, fallbackGdMicroUsdPerToken);
    }

    function setMinimumUsdThresholds(uint256 minFirstDepositMicroUsd_, uint256 minMonthlyStreamMicroUsd_) external onlyOwner {
        minFirstDepositMicroUsd = minFirstDepositMicroUsd_;
        minMonthlyStreamMicroUsd = minMonthlyStreamMicroUsd_;
        emit MinimumsUpdated(minFirstDepositMicroUsd, minMonthlyStreamMicroUsd, fallbackGdMicroUsdPerToken);
    }

    /// @notice Optional registration helper for deployments that want the vault registered as a SuperApp.
    /// @dev The config word is intentionally supplied by deployment scripts because Superfluid app level
    ///      and callback noop bitmap are network/version specific.
    function registerSuperApp(uint256 configWord) external onlyOwner {
        if (superfluidHost == address(0)) revert ZeroAddress();
        ISuperfluidHostLike(superfluidHost).registerApp(configWord);
    }

    /// @notice Classic ERC-20 deposit path. ERC677/777 callbacks below provide single-transaction deposits.
    /// @param data ABI-encoded AntSeed buyer address: `abi.encode(buyerAddress)`. Required.
    function deposit(uint256 amount, bytes calldata data) external returns (uint256) {
        if (amount == 0) revert ZeroAmount();
        address buyer = _decodeBuyer(data);
        if (buyer == address(0)) revert MissingBuyerAddress();
        if (totalDepositedGd[msg.sender] == 0 && _gdWeiToMicroUsd(amount) < minFirstDepositMicroUsd) revert FirstDepositBelowMinimum();
        totalDepositedGd[msg.sender] += amount;
        _safeTransferFrom(msg.sender, address(this), amount);
        emit GdDeposited(msg.sender, buyer, amount, data);
        return totalDepositedGd[msg.sender];
    }

    /// @notice ERC677 / ERC667 transferAndCall receiver.
    /// @dev `data` must be `abi.encode(buyerAddress)` — the AntSeed buyer to credit.
    function onTokenTransfer(address from, uint256 amount, bytes calldata data) external onlyGdToken returns (bool) {
        _recordTokenCallbackDeposit(from, amount, data);
        return true;
    }

    /// @notice Legacy ERC223/ERC667-style token fallback receiver used by some token implementations.
    function tokenFallback(address from, uint256 amount, bytes calldata data) external onlyGdToken {
        _recordTokenCallbackDeposit(from, amount, data);
    }

    /// @notice ERC777 tokensReceived hook. Register this implementer in ERC1820 when using ERC777 delivery.
    /// @dev `userData` must be `abi.encode(buyerAddress)` — the AntSeed buyer to credit.
    function tokensReceived(
        address,
        address from,
        address to,
        uint256 amount,
        bytes calldata userData,
        bytes calldata
    ) external onlyGdToken {
        if (to != address(this)) revert WrongReceiver();
        _recordTokenCallbackDeposit(from, amount, userData);
    }

    function beforeAgreementCreated(
        address superToken,
        address agreementClass,
        bytes32,
        bytes calldata agreementData,
        bytes calldata
    ) external view onlySuperfluidHost returns (bytes memory cbdata) {
        return _currentFlowSnapshot(superToken, agreementClass, agreementData);
    }

    function beforeAgreementUpdated(
        address superToken,
        address agreementClass,
        bytes32,
        bytes calldata agreementData,
        bytes calldata
    ) external view onlySuperfluidHost returns (bytes memory cbdata) {
        return _currentFlowSnapshot(superToken, agreementClass, agreementData);
    }

    function beforeAgreementTerminated(
        address superToken,
        address agreementClass,
        bytes32,
        bytes calldata agreementData,
        bytes calldata
    ) external view onlySuperfluidHost returns (bytes memory cbdata) {
        return _currentFlowSnapshot(superToken, agreementClass, agreementData);
    }

    function afterAgreementCreated(
        address superToken,
        address agreementClass,
        bytes32,
        bytes calldata agreementData,
        bytes calldata cbdata,
        bytes calldata ctx
    ) external onlySuperfluidHost returns (bytes memory newCtx) {
        bytes memory userData = ISuperfluidHostLike(superfluidHost).decodeCtx(ctx).userData;
        address buyer = _decodeBuyer(userData);
        _recordStream(superToken, agreementClass, agreementData, cbdata, buyer);
        return ctx;
    }

    function afterAgreementUpdated(
        address superToken,
        address agreementClass,
        bytes32,
        bytes calldata agreementData,
        bytes calldata cbdata,
        bytes calldata ctx
    ) external onlySuperfluidHost returns (bytes memory newCtx) {
        bytes memory userData = ISuperfluidHostLike(superfluidHost).decodeCtx(ctx).userData;
        address buyer = _decodeBuyer(userData);
        _recordStream(superToken, agreementClass, agreementData, cbdata, buyer);
        return ctx;
    }

    function afterAgreementTerminated(
        address superToken,
        address agreementClass,
        bytes32,
        bytes calldata agreementData,
        bytes calldata cbdata,
        bytes calldata ctx
    ) external onlySuperfluidHost returns (bytes memory newCtx) {
        (address sender,) = abi.decode(agreementData, (address, address));
        address buyer = streamBuyer[sender];
        _recordStream(superToken, agreementClass, agreementData, cbdata, buyer);
        return ctx;
    }

    function _recordTokenCallbackDeposit(address account, uint256 amount, bytes calldata data) private {
        if (amount == 0) revert ZeroAmount();
        address buyer = _decodeBuyer(data);
        if (buyer == address(0)) revert MissingBuyerAddress();
        if (totalDepositedGd[account] == 0 && _gdWeiToMicroUsd(amount) < minFirstDepositMicroUsd) revert FirstDepositBelowMinimum();
        totalDepositedGd[account] += amount;
        emit GdDeposited(account, buyer, amount, data);
    }

    function _recordStream(
        address superToken,
        address agreementClass,
        bytes calldata agreementData,
        bytes calldata cbdata,
        address buyer
    ) private {
        if (superToken != address(gdToken)) revert UnsupportedToken();
        if (agreementClass != cfaV1) revert UnsupportedAgreement();

        (address sender, address receiver) = abi.decode(agreementData, (address, address));
        if (receiver != address(this)) revert WrongReceiver();

        streamBuyer[sender] = buyer;

        (uint256 previousTimestamp, int96 previousFlowRate) = _decodeFlowSnapshot(cbdata);
        (uint256 currentTimestamp, int96 flowRate,,) = IConstantFlowAgreementV1Like(cfaV1).getFlow(superToken, sender, address(this));
        if (flowRate < 0) revert NegativeFlowRate();

        streamFlowRate[sender] = flowRate;
        uint256 monthlyAmount = uint256(uint96(flowRate)) * 30 days;
        if (monthlyAmount > 0 && _gdWeiToMicroUsd(monthlyAmount) < minMonthlyStreamMicroUsd) revert StreamRateBelowMinimum();
        streamMonthlyGdAmount[sender] = monthlyAmount;

        uint256 elapsedSeconds = currentTimestamp > previousTimestamp ? currentTimestamp - previousTimestamp : 0;
        uint256 totalFlow = 0;
        if (previousFlowRate > 0 && elapsedSeconds > 0) {
            totalFlow = uint256(uint96(previousFlowRate)) * elapsedSeconds;
        }

        emit StreamUpdated(sender, buyer, flowRate, monthlyAmount, totalFlow);
    }

    function _currentFlowSnapshot(address superToken, address agreementClass, bytes calldata agreementData)
        private
        view
        returns (bytes memory cbdata)
    {
        if (superToken != address(gdToken) || agreementClass != cfaV1) {
            return abi.encode(uint256(0), int96(0));
        }

        (address sender, address receiver) = abi.decode(agreementData, (address, address));
        if (receiver != address(this)) {
            return abi.encode(uint256(0), int96(0));
        }

        (uint256 timestamp, int96 flowRate,,) = IConstantFlowAgreementV1Like(cfaV1).getFlow(superToken, sender, address(this));
        return abi.encode(timestamp, flowRate);
    }

    /// @dev Decodes the AntSeed buyer address from `data` (abi.encode(address)). Returns address(0) if absent/invalid.
    function _decodeBuyer(bytes memory data) private pure returns (address buyer) {
        if (data.length < 32) return address(0);
        return abi.decode(data, (address));
    }

    function _decodeFlowSnapshot(bytes calldata cbdata) private pure returns (uint256 previousTimestamp, int96 previousFlowRate) {
        if (cbdata.length != 64) return (0, 0);
        return abi.decode(cbdata, (uint256, int96));
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(gdToken).call(abi.encodeWithSelector(IERC20Like.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _gdWeiToMicroUsd(uint256 gdAmountWei) private view returns (uint256) {
        return (gdAmountWei * _gdMicroUsdPerToken()) / 1e18;
    }

    function _gdMicroUsdPerToken() private view returns (uint256) {
        address oracle = reservePriceOracle;
        if (oracle != address(0)) {
            (bool ok, bytes memory data) = oracle.staticcall(abi.encodeWithSelector(IReservePriceOracleLike.currentPriceDAI.selector));
            if (ok && data.length >= 32) {
                uint256 reservePriceDai = abi.decode(data, (uint256));
                uint256 price = (reservePriceDai * MICRO_USD_PER_USD) / RESERVE_PRICE_DECIMALS;
                return price;
            }
        }
        return fallbackGdMicroUsdPerToken;
    }
}
