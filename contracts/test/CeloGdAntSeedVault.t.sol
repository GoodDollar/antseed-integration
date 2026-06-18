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
}

contract MockGoodID {
    mapping(address => bool) public whitelisted;
    mapping(address => address) public roots;

    function setWhitelisted(address account, bool value) external {
        whitelisted[account] = value;
        roots[account] = value ? account : address(0);
    }

    function setRoot(address account, address root) external {
        whitelisted[account] = root != address(0);
        roots[account] = root;
    }

    function isWhitelisted(address account) external view returns (bool) {
        return whitelisted[account];
    }

    function getWhitelistedRoot(address account) external view returns (address) {
        return roots[account];
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

contract MockReservePriceOracle {
    uint256 public priceDai;

    function setCurrentPriceDAI(uint256 value) external {
        priceDai = value;
    }

    function currentPriceDAI() external view returns (uint256) {
        return priceDai;
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

contract CeloGdAntSeedVaultTest {
    MockGdToken token;
    MockGdToken superToken;
    MockGoodID goodId;
    MockCFA cfa;
    MockSuperfluidHost host;
    CeloGdAntSeedVault vault;
    UserProxy user;

    address constant BUYER = address(0xBEEF);

    function setUp() public {
        token = new MockGdToken();
        superToken = new MockGdToken();
        goodId = new MockGoodID();
        cfa = new MockCFA();
        host = new MockSuperfluidHost(cfa);
        CeloGdAntSeedVault impl = new CeloGdAntSeedVault(address(token), address(superToken));
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(CeloGdAntSeedVault.initialize, (address(this), address(goodId), address(host), address(cfa)))
        );
        vault = CeloGdAntSeedVault(address(proxy));
        user = new UserProxy(token, vault, BUYER);
        goodId.setWhitelisted(address(user), true);
        token.mint(address(user), 1_000 ether);
    }

    function testClassicDepositRequiresGoodIDAndTransfersGd() public {
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

    function testRejectsUnverifiedDeposit() public {
        setUp();
        goodId.setWhitelisted(address(user), false);
        user.approveVault(1 ether);
        (bool ok,) = address(user).call(abi.encodeWithSignature("deposit(uint256)", 1 ether));
        require(!ok, "unverified deposit rejected");
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

    function testGoodIdRootAlsoVerifiesConnectedWallet() public {
        setUp();
        address root = address(0xA11CE);
        goodId.setRoot(address(user), root);
        user.transferAndCall(5 ether);
        require(vault.totalDepositedGd(address(user)) == 5 ether, "root verified deposit recorded");
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
            address(superToken),
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
        bytes memory returnedCtx = host.createFlow(vault, address(superToken), address(user), flowRate, ctx);
        require(keccak256(returnedCtx) == keccak256(ctx), "create ctx preserved");
        require(vault.streamFlowRate(address(user)) == flowRate, "flow recorded");
        require(vault.streamMonthlyGdAmount(address(user)) == uint256(uint96(flowRate)) * 30 days, "monthly amount recorded");
        require(vault.streamBuyer(address(user)) == BUYER, "buyer recorded");

        int96 updatedFlowRate = flowRate * 2;
        returnedCtx = host.updateFlow(vault, address(superToken), address(user), updatedFlowRate, ctx);
        require(keccak256(returnedCtx) == keccak256(ctx), "update ctx preserved");
        require(vault.streamFlowRate(address(user)) == updatedFlowRate, "updated flow recorded");
        require(vault.streamBuyer(address(user)) == BUYER, "buyer preserved on update");

        goodId.setWhitelisted(address(user), false);
        returnedCtx = host.terminateFlow(vault, address(superToken), address(user), ctx);
        require(keccak256(returnedCtx) == keccak256(ctx), "termination ctx preserved");
        require(vault.streamFlowRate(address(user)) == 0, "termination cleared flow");
        require(vault.streamMonthlyGdAmount(address(user)) == 0, "termination cleared monthly amount");
    }

    function testSuperAppRejectsWrongTokenAgreementReceiverAndNegativeFlow() public {
        setUp();
        (bool ok,) = address(host).call(abi.encodeWithSignature(
            "createFlow(address,address,address,int96,bytes)",
            address(vault),
            address(token),
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
            address(superToken),
            address(user),
            int96(1),
            ""
        ));
        require(!ok, "wrong agreement rejected");

        vault.setSuperfluidConfig(address(host), address(cfa));
        (ok,) = address(host).call(abi.encodeWithSignature(
            "createFlowWrongReceiver(address,address,address,address,int96)",
            address(vault),
            address(superToken),
            address(user),
            address(0xBEEF),
            int96(1)
        ));
        require(!ok, "wrong receiver rejected");

        (ok,) = address(host).call(abi.encodeWithSignature(
            "createFlow(address,address,address,int96,bytes)",
            address(vault),
            address(superToken),
            address(user),
            int96(-1),
            ""
        ));
        require(!ok, "negative flow rejected");
    }

    function testSuperfluidCreateRequiresGoodIDButTerminationCanClear() public {
        setUp();
        goodId.setWhitelisted(address(user), false);
        (bool ok,) = address(host).call(abi.encodeWithSignature(
            "createFlow(address,address,address,int96,bytes)",
            address(vault),
            address(superToken),
            address(user),
            int96(10),
            ""
        ));
        require(!ok, "unverified stream create rejected");

        host.terminateFlow(vault, address(superToken), address(user), "");
        require(vault.streamFlowRate(address(user)) == 0, "termination allowed");
    }

    function testRejectsMonthlyStreamBelowOneUsd() public {
        setUp();
        (bool ok,) = address(host).call(abi.encodeWithSignature(
            "createFlow(address,address,address,int96,bytes)",
            address(vault),
            address(superToken),
            address(user),
            int96(1),
            ""
        ));
        require(!ok, "monthly stream below minimum rejected");
    }

    function testUsesReserveCurrentPriceForFirstDepositThreshold() public {
        setUp();
        MockReservePriceOracle reserve = new MockReservePriceOracle();
        reserve.setCurrentPriceDAI(5e17); // 0.5 DAI per G$
        vault.setReserveConfig(address(reserve), 0);

        user.approveVault(2 ether);
        (bool ok,) = address(user).call(abi.encodeWithSignature("deposit(uint256)", 1.5 ether));
        require(!ok, "first deposit below $1 reserve equivalent rejected");

        user.deposit(2 ether);
        require(vault.totalDepositedGd(address(user)) == 2 ether, "deposit at reserve-derived threshold succeeds");
    }

    function testUsesReserveCurrentPriceForStreamMinimum() public {
        setUp();
        MockReservePriceOracle reserve = new MockReservePriceOracle();
        reserve.setCurrentPriceDAI(2e17); // 0.2 DAI per G$
        vault.setReserveConfig(address(reserve), 0);
        uint256 monthSeconds = uint256(30 days);

        uint256 lowFlowValue = uint256(4 ether) / monthSeconds;
        int96 lowFlow = int96(int256(lowFlowValue));
        (bool ok,) = address(host).call(abi.encodeWithSignature(
            "createFlow(address,address,address,int96,bytes)",
            address(vault),
            address(superToken),
            address(user),
            lowFlow,
            ""
        ));
        require(!ok, "stream below $1 reserve equivalent rejected");

        uint256 minFlowValue = (uint256(5 ether) + monthSeconds - 1) / monthSeconds;
        int96 minFlow = int96(int256(minFlowValue));
        bytes memory buyerCtx = abi.encode(BUYER);
        bytes memory returnedCtx = host.createFlow(vault, address(superToken), address(user), minFlow, buyerCtx);
        require(keccak256(returnedCtx) == keccak256(buyerCtx), "ctx passthrough");
        require(vault.streamFlowRate(address(user)) == minFlow, "stream at reserve-derived threshold succeeds");
    }

    function testAcceptsHighReservePriceWithoutReasonableBoundsFallback() public {
        setUp();
        MockReservePriceOracle reserve = new MockReservePriceOracle();
        reserve.setCurrentPriceDAI(2e21); // 2000 DAI per G$ -> above the old max-reasonable bound path
        vault.setReserveConfig(address(reserve), 0);

        user.approveVault(1 ether);
        user.deposit(0.001 ether);
        require(vault.totalDepositedGd(address(user)) == 0.001 ether, "high reserve price should be used directly");
    }

    function testCannotReinitialize() public {
        setUp();
        (bool ok,) = address(vault).call(
            abi.encodeCall(CeloGdAntSeedVault.initialize, (address(this), address(goodId), address(host), address(cfa)))
        );
        require(!ok, "double init rejected");
    }

    function testOnlyOwnerCanUpgrade() public {
        setUp();
        CeloGdAntSeedVault newImpl = new CeloGdAntSeedVault(address(token), address(superToken));
        // owner (address(this)) can call upgradeToAndCall
        vault.upgradeToAndCall(address(newImpl), "");

        // non-owner cannot
        UpgradeHelper outsider = new UpgradeHelper();
        (bool ok,) = address(outsider).call(
            abi.encodeWithSignature("upgrade(address,address)", address(vault), address(newImpl))
        );
        require(!ok, "non-owner upgrade rejected");
    }
}

contract UpgradeHelper {
    function upgrade(address vault, address newImpl) external {
        CeloGdAntSeedVault(vault).upgradeToAndCall(newImpl, "");
    }
}
