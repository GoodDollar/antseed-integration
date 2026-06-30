// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CeloGdAntSeedVault, IERC20Like, ISuperfluidHostLike} from "../src/CeloGdAntSeedVault.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract MockGdToken is IERC20Like {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        require(balanceOf[from] >= amount, "BALANCE");
        require(allowance[from][msg.sender] >= amount, "ALLOWANCE");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferAndCall(address to, uint256 amount, bytes calldata data) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        (bool ok, bytes memory result) = to.call(abi.encodeWithSignature("onTokenTransfer(address,uint256,bytes)", msg.sender, amount, data));
        require(ok && abi.decode(result, (bool)), "CALLBACK");
        return true;
    }

    function erc777Send(address operator, address from, address to, uint256 amount, bytes calldata userData) external returns (bool) {
        require(balanceOf[from] >= amount, "BALANCE");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        (bool ok,) = to.call(abi.encodeWithSignature(
            "tokensReceived(address,address,address,uint256,bytes,bytes)",
            operator,
            from,
            to,
            amount,
            userData,
            bytes("")
        ));
        require(ok, "TOKENS_RECEIVED");
        return true;
    }

    function callTokenFallback(address target, address from, uint256 amount, bytes calldata data) external returns (bool) {
        require(balanceOf[from] >= amount, "BALANCE");
        balanceOf[from] -= amount;
        balanceOf[target] += amount;
        (bool ok,) = target.call(abi.encodeWithSignature("tokenFallback(address,uint256,bytes)", from, amount, data));
        return ok;
    }

    /// @dev Calls vault's tokensReceived with a caller-supplied `to` to trigger WrongReceiver checks.
    function callTokensReceivedWithTo(address target, address from, address to, uint256 amount, bytes calldata userData) external returns (bool) {
        (bool ok,) = target.call(abi.encodeWithSignature(
            "tokensReceived(address,address,address,uint256,bytes,bytes)",
            address(this), from, to, amount, userData, bytes("")
        ));
        return ok;
    }
}

contract MockCFA {
    mapping(address => int96) public flowRates;
    mapping(address => uint256) public flowUpdatedAt;

    function setFlow(address sender, int96 flowRate) external {
        setFlowAt(sender, flowRate, block.timestamp);
    }

    function setFlowAt(address sender, int96 flowRate, uint256 timestamp) public {
        flowRates[sender] = flowRate;
        flowUpdatedAt[sender] = timestamp;
    }

    function getFlow(address, address sender, address) external view returns (uint256, int96, uint256, uint256) {
        return (flowUpdatedAt[sender], flowRates[sender], 0, 0);
    }
}

contract MockSuperfluidHost {
    MockCFA public cfa;
    address public registeredApp;
    uint256 public registeredConfigWord;

    constructor(MockCFA cfa_) {
        cfa = cfa_;
    }

    function registerApp(uint256 configWord) external {
        registeredApp = msg.sender;
        registeredConfigWord = configWord;
    }

    /// @dev For testing: treats the entire ctx bytes as userData so tests can pass abi.encode(buyer) as ctx.
    function decodeCtx(bytes calldata ctx) external pure returns (ISuperfluidHostLike.Context memory context) {
        context.userData = ctx;
    }

    function createFlow(CeloGdAntSeedVault vault, address superToken, address sender, int96 flowRate, bytes calldata ctx)
        external
        returns (bytes memory)
    {
        bytes memory cbdata = vault.beforeAgreementCreated(superToken, address(cfa), bytes32(0), abi.encode(sender, address(vault)), ctx);
        cfa.setFlowAt(sender, flowRate, block.timestamp);
        return vault.afterAgreementCreated(superToken, address(cfa), bytes32(0), abi.encode(sender, address(vault)), cbdata, ctx);
    }

    function updateFlow(CeloGdAntSeedVault vault, address superToken, address sender, int96 flowRate, bytes calldata ctx)
        external
        returns (bytes memory)
    {
        bytes memory cbdata = vault.beforeAgreementUpdated(superToken, address(cfa), bytes32(0), abi.encode(sender, address(vault)), ctx);
        cfa.setFlowAt(sender, flowRate, block.timestamp);
        return vault.afterAgreementUpdated(superToken, address(cfa), bytes32(0), abi.encode(sender, address(vault)), cbdata, ctx);
    }

    function terminateFlow(CeloGdAntSeedVault vault, address superToken, address sender, bytes calldata ctx)
        external
        returns (bytes memory)
    {
        bytes memory cbdata = vault.beforeAgreementTerminated(superToken, address(cfa), bytes32(0), abi.encode(sender, address(vault)), ctx);
        cfa.setFlowAt(sender, 0, block.timestamp);
        return vault.afterAgreementTerminated(superToken, address(cfa), bytes32(0), abi.encode(sender, address(vault)), cbdata, ctx);
    }

    function createFlowWrongReceiver(CeloGdAntSeedVault vault, address superToken, address sender, address receiver, int96 flowRate)
        external
        returns (bytes memory)
    {
        cfa.setFlow(sender, flowRate);
        bytes memory cbdata = vault.beforeAgreementCreated(superToken, address(cfa), bytes32(0), abi.encode(sender, receiver), "");
        return vault.afterAgreementCreated(superToken, address(cfa), bytes32(0), abi.encode(sender, receiver), cbdata, "");
    }
}

contract MockStaticOracle {
    uint256 public quoteResult;

    function setQuoteResult(uint256 value) external {
        quoteResult = value;
    }

    function quoteAllAvailablePoolsWithTimePeriod(
        uint128 baseAmount,
        address,
        address,
        uint32
    ) external view returns (uint256 quoteAmount, address[] memory queriedPools) {
        return (quoteResult * baseAmount / 1e18, new address[](0));
    }
}

contract MockRevertingOracle {
    function quoteAllAvailablePoolsWithTimePeriod(uint128, address, address, uint32)
        external pure returns (uint256, address[] memory)
    {
        revert("oracle failure");
    }
}

contract UserProxy {
    MockGdToken public token;
    CeloGdAntSeedVault public vault;
    address public buyer;

    constructor(MockGdToken token_, CeloGdAntSeedVault vault_, address buyer_) {
        token = token_;
        vault = vault_;
        buyer = buyer_;
    }

    function approveVault(uint256 amount) external {
        token.approve(address(vault), amount);
    }

    function deposit(uint256 amount) external {
        vault.deposit(amount, abi.encode(buyer));
    }

    function transferAndCall(uint256 amount) external {
        token.transferAndCall(address(vault), amount, abi.encode(buyer));
    }
}

contract HostProxy {
    function created(CeloGdAntSeedVault vault, address superToken, address cfa, address sender) external {
        vault.afterAgreementCreated(superToken, cfa, bytes32(0), abi.encode(sender, address(vault)), "", "");
    }

    function updated(CeloGdAntSeedVault vault, address superToken, address cfa, address sender) external {
        vault.afterAgreementUpdated(superToken, cfa, bytes32(0), abi.encode(sender, address(vault)), "", "");
    }

    function terminated(CeloGdAntSeedVault vault, address superToken, address cfa, address sender) external {
        vault.afterAgreementTerminated(superToken, cfa, bytes32(0), abi.encode(sender, address(vault)), "", "");
    }
}

contract FailingToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address, uint256) external pure returns (bool) { return true; }
    function transfer(address, uint256) external pure returns (bool) { return false; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return false; }
}

contract Outsider {
    CeloGdAntSeedVault public vault;

    constructor(CeloGdAntSeedVault vault_) { vault = vault_; }

    function transferOwnership(address to) external { vault.transferOwnership(to); }
    function setSuperfluidConfig(address h, address c) external { vault.setSuperfluidConfig(h, c); }
    function setStaticOracleConfig(address o, address c, uint256 f) external { vault.setStaticOracleConfig(o, c, f); }
    function setMinimumUsdThresholds(uint256 a, uint256 b) external { vault.setMinimumUsdThresholds(a, b); }
    function registerSuperApp(uint256 w) external { vault.registerSuperApp(w); }
}

contract CeloGdAntSeedVaultTest {
    MockGdToken token;
    MockCFA cfa;
    MockSuperfluidHost host;
    CeloGdAntSeedVault vault;
    UserProxy user;

    address constant BUYER = address(0xBEEF);

    function setUp() public {
        token = new MockGdToken();
        cfa = new MockCFA();
        host = new MockSuperfluidHost(cfa);
        CeloGdAntSeedVault impl = new CeloGdAntSeedVault(address(token));
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(CeloGdAntSeedVault.initialize, (address(this), address(host), address(cfa)))
        );
        vault = CeloGdAntSeedVault(address(proxy));
        // Set fallback to 1e18 so 1 G$ wei = 1 USD wei; makes minimum math trivial in basic tests.
        vault.setStaticOracleConfig(address(0), address(0), 1e18);
        user = new UserProxy(token, vault, BUYER);
        token.mint(address(user), 1_000 ether);
    }

    function testClassicDepositTransfersGd() public {
        setUp();
        user.approveVault(100 ether);
        user.deposit(100 ether);
        require(vault.totalDepositedGd(address(user)) == 100 ether, "deposit recorded");
        require(token.balanceOf(address(vault)) == 100 ether, "vault funded");
    }

    function testErc677TransferAndCallSingleTxDeposit() public {
        setUp();
        user.transferAndCall(25 ether);
        require(vault.totalDepositedGd(address(user)) == 25 ether, "erc677 deposit recorded");
        require(token.balanceOf(address(vault)) == 25 ether, "vault funded");
    }

    function testErc777TokensReceivedSingleTxDeposit() public {
        setUp();
        token.erc777Send(address(0xBEEF), address(user), address(vault), 30 ether, abi.encode(BUYER));
        require(vault.totalDepositedGd(address(user)) == 30 ether, "erc777 deposit recorded");
        require(token.balanceOf(address(vault)) == 30 ether, "vault funded");
    }

    function testRejectsFirstDepositBelowOneUsdAndAllowsLaterSmallTopUps() public {
        setUp();
        user.approveVault(2 ether);
        (bool ok,) = address(user).call(abi.encodeWithSignature("deposit(uint256)", 0.5 ether));
        require(!ok, "first deposit below minimum rejected");

        user.deposit(1 ether);
        user.deposit(0.25 ether);
        require(vault.totalDepositedGd(address(user)) == 1.25 ether, "subsequent top up allowed");
    }

    function testRegisterSuperAppCallsConfiguredHost() public {
        setUp();
        vault.registerSuperApp(12345);
        require(host.registeredApp() == address(vault), "registered app");
        require(host.registeredConfigWord() == 12345, "config word");
    }

    function testOnlySuperfluidHostCanCallCallbacks() public {
        setUp();
        (bool ok,) = address(vault).call(abi.encodeWithSignature(
            "afterAgreementCreated(address,address,bytes32,bytes,bytes,bytes)",
            address(token),
            address(cfa),
            bytes32(0),
            abi.encode(address(user), address(vault)),
            "",
            ""
        ));
        require(!ok, "non-host callback rejected");
    }

    function testSuperAppCreateUpdateTerminateStreamLifecycleAndPreservesCtx() public {
        setUp();
        // ctx is treated as userData by MockSuperfluidHost.decodeCtx; pass abi.encode(buyer) so vault can decode it.
        bytes memory ctx = abi.encode(BUYER);
        int96 flowRate = 38580246913580; // ~100 G$ / 30 days at 18 decimals
        bytes memory returnedCtx = host.createFlow(vault, address(token), address(user), flowRate, ctx);
        require(keccak256(returnedCtx) == keccak256(ctx), "create ctx preserved");
        require(vault.streamFlowRate(address(user)) == flowRate, "flow recorded");
        require(vault.streamMonthlyGdAmount(address(user)) == uint256(uint96(flowRate)) * 30 days, "monthly amount recorded");
        require(vault.streamBuyer(address(user)) == BUYER, "buyer recorded");

        int96 updatedFlowRate = flowRate * 2;
        returnedCtx = host.updateFlow(vault, address(token), address(user), updatedFlowRate, ctx);
        require(keccak256(returnedCtx) == keccak256(ctx), "update ctx preserved");
        require(vault.streamFlowRate(address(user)) == updatedFlowRate, "updated flow recorded");
        require(vault.streamBuyer(address(user)) == BUYER, "buyer preserved on update");

        returnedCtx = host.terminateFlow(vault, address(token), address(user), ctx);
        require(keccak256(returnedCtx) == keccak256(ctx), "termination ctx preserved");
        require(vault.streamFlowRate(address(user)) == 0, "termination cleared flow");
        require(vault.streamMonthlyGdAmount(address(user)) == 0, "termination cleared monthly amount");
    }

    function testSuperAppRejectsWrongTokenAgreementReceiverAndNegativeFlow() public {
        setUp();
        MockGdToken wrongToken = new MockGdToken();
        (bool ok,) = address(host).call(abi.encodeWithSignature(
            "createFlow(address,address,address,int96,bytes)",
            address(vault),
            address(wrongToken),
            address(user),
            int96(1),
            ""
        ));
        require(!ok, "wrong token rejected");

        MockCFA otherCfa = new MockCFA();
        vault.setSuperfluidConfig(address(host), address(otherCfa));
        (ok,) = address(host).call(abi.encodeWithSignature(
            "createFlow(address,address,address,int96,bytes)",
            address(vault),
            address(token),
            address(user),
            int96(1),
            ""
        ));
        require(!ok, "wrong agreement rejected");

        vault.setSuperfluidConfig(address(host), address(cfa));
        (ok,) = address(host).call(abi.encodeWithSignature(
            "createFlowWrongReceiver(address,address,address,address,int96)",
            address(vault),
            address(token),
            address(user),
            address(0xBEEF),
            int96(1)
        ));
        require(!ok, "wrong receiver rejected");

        (ok,) = address(host).call(abi.encodeWithSignature(
            "createFlow(address,address,address,int96,bytes)",
            address(vault),
            address(token),
            address(user),
            int96(-1),
            ""
        ));
        require(!ok, "negative flow rejected");
    }

    function testRejectsMonthlyStreamBelowOneUsd() public {
        setUp();
        (bool ok,) = address(host).call(abi.encodeWithSignature(
            "createFlow(address,address,address,int96,bytes)",
            address(vault),
            address(token),
            address(user),
            int96(1),
            ""
        ));
        require(!ok, "monthly stream below minimum rejected");
    }

    function testUsesStaticOracleForFirstDepositThreshold() public {
        setUp();
        MockStaticOracle oracle = new MockStaticOracle();
        oracle.setQuoteResult(5e17); // 0.5 cUSD per G$
        vault.setStaticOracleConfig(address(oracle), address(0xCCCC), 0);

        user.approveVault(2 ether);
        (bool ok,) = address(user).call(abi.encodeWithSignature("deposit(uint256)", 1.5 ether));
        require(!ok, "first deposit below $1 reserve equivalent rejected");

        user.deposit(2 ether);
        require(vault.totalDepositedGd(address(user)) == 2 ether, "deposit at oracle-derived threshold succeeds");
    }

    function testUsesStaticOracleForStreamMinimum() public {
        setUp();
        MockStaticOracle oracle = new MockStaticOracle();
        oracle.setQuoteResult(2e17); // 0.2 cUSD per G$
        vault.setStaticOracleConfig(address(oracle), address(0xCCCC), 0);
        uint256 monthSeconds = uint256(30 days);

        uint256 lowFlowValue = uint256(4 ether) / monthSeconds;
        int96 lowFlow = int96(int256(lowFlowValue));
        (bool ok,) = address(host).call(abi.encodeWithSignature(
            "createFlow(address,address,address,int96,bytes)",
            address(vault),
            address(token),
            address(user),
            lowFlow,
            ""
        ));
        require(!ok, "stream below $1 reserve equivalent rejected");

        uint256 minFlowValue = (uint256(5 ether) + monthSeconds - 1) / monthSeconds;
        int96 minFlow = int96(int256(minFlowValue));
        bytes memory buyerCtx = abi.encode(BUYER);
        bytes memory returnedCtx = host.createFlow(vault, address(token), address(user), minFlow, buyerCtx);
        require(keccak256(returnedCtx) == keccak256(buyerCtx), "ctx passthrough");
        require(vault.streamFlowRate(address(user)) == minFlow, "stream at reserve-derived threshold succeeds");
    }

    function testAcceptsHighStaticOraclePriceWithoutReasonableBoundsFallback() public {
        setUp();
        MockStaticOracle oracle = new MockStaticOracle();
        oracle.setQuoteResult(2e21); // 2000 cUSD per G$ -> above the old max-reasonable bound path
        vault.setStaticOracleConfig(address(oracle), address(0xCCCC), 0);

        user.approveVault(1 ether);
        user.deposit(0.001 ether);
        require(vault.totalDepositedGd(address(user)) == 0.001 ether, "high reserve price should be used directly");
    }

    function testCannotReinitialize() public {
        setUp();
        (bool ok,) = address(vault).call(
            abi.encodeCall(CeloGdAntSeedVault.initialize, (address(this), address(host), address(cfa)))
        );
        require(!ok, "double init rejected");
    }

    function testOnlyOwnerCanUpgrade() public {
        setUp();
        CeloGdAntSeedVault newImpl = new CeloGdAntSeedVault(address(token));
        // owner (address(this)) can call upgradeToAndCall
        vault.upgradeToAndCall(address(newImpl), "");

        // non-owner cannot
        UpgradeHelper outsider = new UpgradeHelper();
        (bool ok,) = address(outsider).call(
            abi.encodeWithSignature("upgrade(address,address)", address(vault), address(newImpl))
        );
        require(!ok, "non-owner upgrade rejected");
    }

    // --- ZeroAmount ---

    function testDepositRejectsZeroAmount() public {
        setUp();
        (bool ok,) = address(vault).call(
            abi.encodeWithSignature("deposit(uint256,bytes)", uint256(0), abi.encode(BUYER))
        );
        require(!ok, "zero amount deposit rejected");
    }

    // --- MissingBuyerAddress ---

    function testDepositRejectsMissingBuyer() public {
        setUp();
        user.approveVault(1 ether);
        (bool ok,) = address(vault).call(
            abi.encodeWithSignature("deposit(uint256,bytes)", uint256(1 ether), bytes(""))
        );
        require(!ok, "missing buyer rejected");
    }

    // --- FirstDepositBelowMinimum and MissingBuyerAddress via ERC677 ---

    function testErc677RejectsFirstDepositBelowMinimum() public {
        setUp();
        token.mint(address(this), 1 ether);
        (bool ok,) = address(token).call(
            abi.encodeWithSignature("transferAndCall(address,uint256,bytes)", address(vault), uint256(0.5 ether), abi.encode(BUYER))
        );
        require(!ok, "erc677 first deposit below minimum rejected");
    }

    function testErc677RejectsMissingBuyer() public {
        setUp();
        token.mint(address(this), 2 ether);
        (bool ok,) = address(token).call(
            abi.encodeWithSignature("transferAndCall(address,uint256,bytes)", address(vault), uint256(1 ether), bytes(""))
        );
        require(!ok, "erc677 missing buyer rejected");
    }

    // --- WrongReceiver in tokensReceived ---

    function testErc777RejectsWrongReceiverInCallback() public {
        setUp();
        bool ok = token.callTokensReceivedWithTo(address(vault), address(user), address(0xBEEF), 1 ether, abi.encode(BUYER));
        require(!ok, "wrong receiver in tokensReceived rejected");
    }

    // --- UnsupportedToken: onlyGdToken modifier ---

    function testTokenCallbacksRejectNonGdToken() public {
        setUp();
        (bool ok,) = address(vault).call(
            abi.encodeWithSignature("onTokenTransfer(address,uint256,bytes)", address(this), uint256(1 ether), abi.encode(BUYER))
        );
        require(!ok, "non-gd token onTokenTransfer rejected");

        (ok,) = address(vault).call(
            abi.encodeWithSignature("tokenFallback(address,uint256,bytes)", address(this), uint256(1 ether), abi.encode(BUYER))
        );
        require(!ok, "non-gd token tokenFallback rejected");
    }

    // --- tokenFallback happy path ---

    function testTokenFallbackDeposit() public {
        setUp();
        token.mint(address(this), 50 ether);
        bool ok = token.callTokenFallback(address(vault), address(this), 50 ether, abi.encode(BUYER));
        require(ok, "tokenFallback deposit succeeded");
        require(vault.totalDepositedGd(address(this)) == 50 ether, "tokenFallback deposit recorded");
    }

    // --- TransferFailed ---

    function testTransferFailedRevertsDeposit() public {
        setUp();
        FailingToken failToken = new FailingToken();
        CeloGdAntSeedVault failImpl = new CeloGdAntSeedVault(address(failToken));
        ERC1967Proxy failProxy = new ERC1967Proxy(
            address(failImpl),
            abi.encodeCall(CeloGdAntSeedVault.initialize, (address(this), address(host), address(cfa)))
        );
        CeloGdAntSeedVault failVault = CeloGdAntSeedVault(address(failProxy));
        failToken.mint(address(this), 1 ether);
        (bool ok,) = address(failVault).call(
            abi.encodeWithSignature("deposit(uint256,bytes)", uint256(1 ether), abi.encode(BUYER))
        );
        require(!ok, "deposit with failing transferFrom reverts");
    }

    // --- InvalidPriceConfig ---

    function testSetStaticOracleConfigRejectsInvalidPriceConfig() public {
        setUp();
        (bool ok,) = address(vault).call(
            abi.encodeWithSignature("setStaticOracleConfig(address,address,uint256)", address(0), address(0), uint256(0))
        );
        require(!ok, "invalid price config rejected");
    }

    // --- NotOwner for all admin functions ---

    function testOnlyOwnerFunctionsRejectNonOwner() public {
        setUp();
        Outsider outsider = new Outsider(vault);

        (bool ok,) = address(outsider).call(
            abi.encodeWithSignature("transferOwnership(address)", address(0xDEAD))
        );
        require(!ok, "non-owner transferOwnership rejected");

        (ok,) = address(outsider).call(
            abi.encodeWithSignature("setSuperfluidConfig(address,address)", address(0), address(0))
        );
        require(!ok, "non-owner setSuperfluidConfig rejected");

        (ok,) = address(outsider).call(
            abi.encodeWithSignature("setStaticOracleConfig(address,address,uint256)", address(0xAB), address(0xAB), uint256(0))
        );
        require(!ok, "non-owner setStaticOracleConfig rejected");

        (ok,) = address(outsider).call(
            abi.encodeWithSignature("setMinimumUsdThresholds(uint256,uint256)", uint256(1), uint256(1))
        );
        require(!ok, "non-owner setMinimumUsdThresholds rejected");

        (ok,) = address(outsider).call(
            abi.encodeWithSignature("registerSuperApp(uint256)", uint256(1))
        );
        require(!ok, "non-owner registerSuperApp rejected");
    }

    // --- ZeroAddress in transferOwnership ---

    function testTransferOwnershipRejectsZeroAddress() public {
        setUp();
        (bool ok,) = address(vault).call(
            abi.encodeWithSignature("transferOwnership(address)", address(0))
        );
        require(!ok, "transferOwnership to zero rejected");
    }

    function testTransferOwnershipWorks() public {
        setUp();
        address newOwner = address(0xA1B2C3);
        vault.transferOwnership(newOwner);
        require(vault.owner() == newOwner, "ownership transferred");
        // former owner can no longer call admin functions
        (bool ok,) = address(vault).call(
            abi.encodeWithSignature("setSuperfluidConfig(address,address)", address(host), address(cfa))
        );
        require(!ok, "former owner admin access revoked");
    }

    // --- ZeroAddress in registerSuperApp when host is address(0) ---

    function testRegisterSuperAppRejectsZeroHost() public {
        setUp();
        vault.setSuperfluidConfig(address(0), address(cfa));
        (bool ok,) = address(vault).call(
            abi.encodeWithSignature("registerSuperApp(uint256)", uint256(12345))
        );
        require(!ok, "registerSuperApp with zero host rejected");
    }

    // --- NotSuperfluidHost for before* callbacks ---

    function testBeforeCallbacksRequireHost() public {
        setUp();
        bytes memory agreementData = abi.encode(address(user), address(vault));

        (bool ok,) = address(vault).call(abi.encodeWithSignature(
            "beforeAgreementCreated(address,address,bytes32,bytes,bytes)",
            address(token), address(cfa), bytes32(0), agreementData, bytes("")
        ));
        require(!ok, "beforeAgreementCreated non-host rejected");

        (ok,) = address(vault).call(abi.encodeWithSignature(
            "beforeAgreementUpdated(address,address,bytes32,bytes,bytes)",
            address(token), address(cfa), bytes32(0), agreementData, bytes("")
        ));
        require(!ok, "beforeAgreementUpdated non-host rejected");

        (ok,) = address(vault).call(abi.encodeWithSignature(
            "beforeAgreementTerminated(address,address,bytes32,bytes,bytes)",
            address(token), address(cfa), bytes32(0), agreementData, bytes("")
        ));
        require(!ok, "beforeAgreementTerminated non-host rejected");
    }

    // --- NotSuperfluidHost for afterAgreementUpdated and afterAgreementTerminated ---

    function testAfterAgreementUpdatedAndTerminatedRequireHost() public {
        setUp();
        bytes memory agreementData = abi.encode(address(user), address(vault));

        (bool ok,) = address(vault).call(abi.encodeWithSignature(
            "afterAgreementUpdated(address,address,bytes32,bytes,bytes,bytes)",
            address(token), address(cfa), bytes32(0), agreementData, bytes(""), bytes("")
        ));
        require(!ok, "afterAgreementUpdated non-host rejected");

        (ok,) = address(vault).call(abi.encodeWithSignature(
            "afterAgreementTerminated(address,address,bytes32,bytes,bytes,bytes)",
            address(token), address(cfa), bytes32(0), agreementData, bytes(""), bytes("")
        ));
        require(!ok, "afterAgreementTerminated non-host rejected");
    }

    // --- setMinimumUsdThresholds happy path ---

    function testSetMinimumUsdThresholds() public {
        setUp();
        vault.setMinimumUsdThresholds(2_000_000, 3_000_000);
        require(vault.minFirstDepositUsd() == 2_000_000, "min deposit threshold updated");
        require(vault.minMonthlyStreamUsd() == 3_000_000, "min stream threshold updated");
    }

    // --- gdUsdPerToken ---

    function testGdUsdPerTokenReturnsFallbackWhenOracleNotSet() public {
        setUp();
        // No oracle configured; should return the fallback set at init.
        require(vault.gdUsdPerToken(1e18) == vault.fallbackGdUsdPerToken(), "returns fallback when no oracle");
    }

    function testGdUsdPerTokenReturnsOraclePrice() public {
        setUp();
        MockStaticOracle oracle = new MockStaticOracle();
        oracle.setQuoteResult(5e17); // 0.5 cUSD per G$
        vault.setStaticOracleConfig(address(oracle), address(0xCCCC), 0);
        require(vault.gdUsdPerToken(1e18) == 5e17, "returns oracle quote directly");
    }

    function testGdUsdPerTokenFallsBackWhenOracleReturnsZero() public {
        setUp();
        MockStaticOracle oracle = new MockStaticOracle();
        oracle.setQuoteResult(0); // oracle returns 0
        vault.setStaticOracleConfig(address(oracle), address(0xCCCC), 1_000_000);
        require(vault.gdUsdPerToken(1e18) == uint256(1e18) * 1e18 / vault.fallbackGdUsdPerToken(), "falls back when oracle returns zero");
    }

    function testGdUsdPerTokenFallsBackWhenOracleReverts() public {
        setUp();
        MockRevertingOracle badOracle = new MockRevertingOracle();
        vault.setStaticOracleConfig(address(badOracle), address(0xCCCC), 999_999);
        require(vault.gdUsdPerToken(1e18) == uint256(1e18) * 1e18 / vault.fallbackGdUsdPerToken(), "falls back when oracle reverts");
    }

    function testGdUsdPerTokenFallsBackWhenCusdIsZero() public {
        setUp();
        MockStaticOracle oracle = new MockStaticOracle();
        oracle.setQuoteResult(5e17);
        // staticOracleCusd is zero (not configured) — oracle path must be skipped
        vault.setStaticOracleConfig(address(0), address(0), 777_777);
        require(vault.gdUsdPerToken(1e18) == uint256(1e18) * 1e18 / vault.fallbackGdUsdPerToken(), "falls back when cusd not set");
    }
}

contract UpgradeHelper {
    function upgrade(address vault, address newImpl) external {
        CeloGdAntSeedVault(vault).upgradeToAndCall(newImpl, "");
    }
}
