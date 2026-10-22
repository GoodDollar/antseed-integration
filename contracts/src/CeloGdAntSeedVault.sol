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
    function getFlow(
        address token,
        address sender,
        address receiver
    ) external view returns (uint256 timestamp, int96 flowRate, uint256 deposit, uint256 owedDeposit);
}

interface IStaticOracleLike {
    function quoteAllAvailablePoolsWithTimePeriod(
        uint128 baseAmount,
        address baseToken,
        address quoteToken,
        uint32 period
    ) external view returns (uint256 quoteAmount, address[] memory queriedPools);
}

/// @title CeloGdAntSeedVault
/// @notice Celo-side G$ vault for AntSeed credits. No bridge logic is included.
/// @dev Accepts direct ERC-20 deposits, ERC677 `transferAndCall` callbacks, Superfluid `batchCall` deposits
///      (`depositFromAction`) and Superfluid SuperApp stream callbacks. The backend converts the emitted
///      events into USDC-denominated credits. G$ is held here; the owner can recover it with `sweepToken`.
contract CeloGdAntSeedVault is Initializable, UUPSUpgradeable {
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
    address public staticOracle;
    /// @notice Minimum USD value (18 decimals) of an account's first deposit.
    uint256 public minFirstDepositUsd;
    /// @notice Minimum USD value (18 decimals) of a stream's 30-day amount.
    uint256 public minMonthlyStreamUsd;
    /// @notice G$ wei that equal 1 USD (18 decimals); used by `gdUsdPerToken` only when the oracle is unavailable.
    uint256 public fallbackGdUsdPerToken;

    /// @notice Lifetime G$ deposited per account through the deposit paths (not streams).
    mapping(address => uint256) public totalDepositedGd;
    mapping(address => int96) private _unused_streamFlowRate;
    mapping(address => uint256) private _unused_streamMonthlyGdAmount;
    /// @notice AntSeed buyer account funded when stream credits are settled for each sender.
    mapping(address => address) public streamBuyer;
    /// @notice cUSD quote token address used by the static oracle.
    address public staticOracleCusd;

    uint256[49] private __gap;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SuperfluidConfigUpdated(address indexed host, address indexed cfaV1);
    event StaticOracleUpdated(address indexed staticOracle, address indexed staticOracleCusd);
    event MinimumsUpdated(uint256 minFirstDepositUsd, uint256 minMonthlyStreamUsd, uint256 fallbackGdUsdPerToken);
    event TokenSwept(address indexed token, address indexed recipient, uint256 amount);
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
        minFirstDepositUsd = 1e18; // 1$
        minMonthlyStreamUsd = 1e18; // 1$
        staticOracle = address(0x00851A91a3c4E9a4c1B48df827Bacc1f884bdE28); // Celo Static Oracle
        staticOracleCusd = address(0x765DE816845861e75A25fCA122bb6898B8B1282a); // cUSD
        fallbackGdUsdPerToken = 9000e18; // 1$ = 9000 G$ (0.0001111 USD per G$)

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

    function setStaticOracleConfig(address staticOracle_, address staticOracleCusd_, uint256 fallbackGdUsdPerToken_) external onlyOwner {
        if ((staticOracle_ == address(0) || staticOracleCusd_ == address(0)) && fallbackGdUsdPerToken_ == 0) revert InvalidPriceConfig();
        staticOracle = staticOracle_;
        staticOracleCusd = staticOracleCusd_;
        if (fallbackGdUsdPerToken_ > 0) fallbackGdUsdPerToken = fallbackGdUsdPerToken_;
        emit StaticOracleUpdated(staticOracle_, staticOracleCusd_);
        emit MinimumsUpdated(minFirstDepositUsd, minMonthlyStreamUsd, fallbackGdUsdPerToken);
    }

    function setMinimumUsdThresholds(uint256 minFirstDepositUsd_, uint256 minMonthlyStreamUsd_) external onlyOwner {
        minFirstDepositUsd = minFirstDepositUsd_;
        minMonthlyStreamUsd = minMonthlyStreamUsd_;
        emit MinimumsUpdated(minFirstDepositUsd, minMonthlyStreamUsd, fallbackGdUsdPerToken);
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
        _recordTokenCallbackDeposit(msg.sender, amount, data);
        _safeTransferFrom(msg.sender, address(this), amount);
        return totalDepositedGd[msg.sender];
    }

    /// @notice `CALL_APP_ACTION` entry point for Superfluid `batchCall` (approve + deposit in one transaction).
    /// @dev The Host replaces the trailing `ctx` placeholder; the depositor is `decodeCtx(ctx).msgSender`.
    ///      `data` is `abi.encode(buyerAddress)`, the AntSeed buyer to credit.
    function depositFromAction(uint256 amount, bytes calldata data, bytes calldata ctx) external onlySuperfluidHost returns (bytes memory newCtx) {
        address sender = ISuperfluidHostLike(superfluidHost).decodeCtx(ctx).msgSender;
        if (sender == address(0)) revert ZeroAddress();
        _recordTokenCallbackDeposit(sender, amount, data);
        _safeTransferFrom(sender, address(this), amount);
        return ctx;
    }

    /// @notice ERC677 / ERC667 transferAndCall receiver.
    /// @dev `data` must be `abi.encode(buyerAddress)` — the AntSeed buyer to credit.
    function onTokenTransfer(address from, uint256 amount, bytes calldata data) external onlyGdToken returns (bool) {
        _recordTokenCallbackDeposit(from, amount, data);
        return true;
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
        _recordStream(superToken, agreementClass, agreementData, cbdata, buyer, false);
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
        (address sender, ) = abi.decode(agreementData, (address, address));
        address buyer = streamBuyer[sender];
        _recordStream(superToken, agreementClass, agreementData, cbdata, buyer, false);
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
        (address sender, ) = abi.decode(agreementData, (address, address));
        address buyer = streamBuyer[sender];
        _recordStream(superToken, agreementClass, agreementData, cbdata, buyer, true);
        return ctx;
    }

    function _recordTokenCallbackDeposit(address account, uint256 amount, bytes calldata data) private {
        if (amount == 0) revert ZeroAmount();
        address buyer = _decodeBuyer(data);
        if (buyer == address(0)) revert MissingBuyerAddress();
        if (totalDepositedGd[account] == 0 && gdUsdPerToken(uint128(amount)) < minFirstDepositUsd) revert FirstDepositBelowMinimum();
        totalDepositedGd[account] += amount;
        emit GdDeposited(account, buyer, amount, data);
    }

    function _recordStream(
        address superToken,
        address agreementClass,
        bytes calldata agreementData,
        bytes calldata cbdata,
        address buyer,
        bool skipRevert
    ) private {
        // A reverting termination callback gets the app jailed by Superfluid, so it must never revert.
        if (superToken != address(gdToken)) {
            if (skipRevert) return;
            revert UnsupportedToken();
        }
        if (agreementClass != cfaV1) {
            if (skipRevert) return;
            revert UnsupportedAgreement();
        }
        if (buyer == address(0)) {
            if (skipRevert) return;
            revert MissingBuyerAddress();
        }

        (address sender, address receiver) = abi.decode(agreementData, (address, address));
        if (receiver != address(this)) {
            if (skipRevert) return;
            revert WrongReceiver();
        }

        streamBuyer[sender] = buyer;

        // CFA reports timestamp 0 for a deleted flow, so use the block time as the end of the elapsed window.
        uint256 currentTimestamp = block.timestamp;
        (uint256 previousTimestamp, int96 previousFlowRate) = _decodeFlowSnapshot(cbdata);
        (, int96 flowRate, , ) = IConstantFlowAgreementV1Like(cfaV1).getFlow(superToken, sender, address(this));
        if (flowRate < 0) revert NegativeFlowRate();

        uint256 monthlyAmount = uint256(uint96(flowRate)) * 30 days;
        if (monthlyAmount > 0 && gdUsdPerToken(uint128(monthlyAmount)) < minMonthlyStreamUsd) revert StreamRateBelowMinimum();

        uint256 elapsedSeconds = currentTimestamp > previousTimestamp ? currentTimestamp - previousTimestamp : 0;
        uint256 totalFlow = 0;
        if (previousFlowRate > 0 && elapsedSeconds > 0) {
            totalFlow = uint256(uint96(previousFlowRate)) * elapsedSeconds;
        }

        emit StreamUpdated(sender, buyer, flowRate, monthlyAmount, totalFlow);
    }

    function _currentFlowSnapshot(address superToken, address agreementClass, bytes calldata agreementData) private view returns (bytes memory cbdata) {
        if (superToken != address(gdToken) || agreementClass != cfaV1) {
            return abi.encode(uint256(0), int96(0));
        }

        (address sender, address receiver) = abi.decode(agreementData, (address, address));
        if (receiver != address(this)) {
            return abi.encode(uint256(0), int96(0));
        }

        (uint256 timestamp, int96 flowRate, , ) = IConstantFlowAgreementV1Like(cfaV1).getFlow(superToken, sender, address(this));
        return abi.encode(timestamp, flowRate);
    }

    /// @dev Decodes `abi.encode(address)`. Returns address(0) if `data` is shorter than 32 bytes; reverts if the word is not a valid address.
    function _decodeBuyer(bytes memory data) private pure returns (address buyer) {
        if (data.length < 32) return address(0);
        return abi.decode(data, (address));
    }

    function _decodeFlowSnapshot(bytes calldata cbdata) private pure returns (uint256 previousTimestamp, int96 previousFlowRate) {
        if (cbdata.length != 64) return (0, 0);
        return abi.decode(cbdata, (uint256, int96));
    }

    /// @notice Recovers G$ (e.g. sent without a deposit callback) or any other token held by the vault.
    function sweepToken(address token, address recipient, uint256 amount) external onlyOwner {
        if (token == address(0) || recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        // A call to an EOA succeeds with empty returndata, which would report a sweep that moved nothing.
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Like.transfer.selector, recipient, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        emit TokenSwept(token, recipient, amount);
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(gdToken).call(abi.encodeWithSelector(IERC20Like.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    /// @notice Returns the USD value (18 decimals, same unit as `minFirstDepositUsd`) of `amount` G$ wei.
    /// @dev Despite the name this is a value quote, not a unit price. Uses the 60s TWAP from the static oracle
    ///      when configured and non-zero, otherwise `amount * 1e18 / fallbackGdUsdPerToken`.
    function gdUsdPerToken(uint128 amount) public view returns (uint256) {
        address oracle = staticOracle;
        address cusd = staticOracleCusd;
        if (oracle != address(0) && cusd != address(0)) {
            (bool ok, bytes memory data) = oracle.staticcall(
                abi.encodeWithSelector(IStaticOracleLike.quoteAllAvailablePoolsWithTimePeriod.selector, uint128(amount), address(gdToken), cusd, uint32(60))
            );
            if (ok && data.length >= 32) {
                uint256 quoteAmount;
                assembly {
                    quoteAmount := mload(add(data, 32))
                }
                if (quoteAmount > 0) {
                    return quoteAmount;
                }
            }
        }
        return (amount * 1e18) / fallbackGdUsdPerToken;
    }
}
