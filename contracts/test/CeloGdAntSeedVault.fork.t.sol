// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {CeloGdAntSeedVault} from "../src/CeloGdAntSeedVault.sol";

interface ISuperfluidHost {
    struct Operation {
        uint32 operationType;
        address target;
        bytes data;
    }

    function batchCall(Operation[] calldata operations) external;

    function callAgreement(address agreementClass, bytes calldata callData, bytes calldata userData) external returns (bytes memory);

    function getAgreementClass(bytes32 agreementType) external view returns (address);

    function isAppJailed(address app) external view returns (bool);
}

interface ICfa {
    function createFlow(address token, address receiver, int96 flowRate, bytes calldata ctx) external returns (bytes memory);

    function updateFlow(address token, address receiver, int96 flowRate, bytes calldata ctx) external returns (bytes memory);

    function deleteFlow(address token, address sender, address receiver, bytes calldata ctx) external returns (bytes memory);

    function getFlow(
        address token,
        address sender,
        address receiver
    ) external view returns (uint256 timestamp, int96 flowRate, uint256 deposit, uint256 owedDeposit);
}

interface ISuperToken {
    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Celo mainnet fork tests: real Superfluid Host/CFA/G$ SuperToken against the new vault implementation.
/// @dev Skipped unless `CELO_RPC_URL` is set. The deployed vault proxy is already a registered SuperApp
///      (registration is whitelisted on mainnet), so the tests upgrade it to the implementation under test.
///      Run: `CELO_RPC_URL=https://forno.celo.org forge test --match-contract CeloGdAntSeedVaultForkTest -vvv`
contract CeloGdAntSeedVaultForkTest is Test {
    using stdStorage for StdStorage;

    event GdDeposited(address indexed account, address indexed buyer, uint256 gdAmount, bytes data);
    event StreamUpdated(address indexed account, address indexed buyer, int96 flowRate, uint256 monthlyGdAmountWei, uint256 totalFlowWei);

    uint32 constant OP_ERC20_APPROVE = 1;
    uint32 constant OP_CALL_APP_ACTION = 202; // 302 is ERC2771_FORWARD_CALL, which does not go through the Host as msg.sender

    ISuperfluidHost constant HOST = ISuperfluidHost(0xA4Ff07cF81C02CFD356184879D953970cA957585);
    ISuperToken constant GD = ISuperToken(0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A);
    address constant PROD_VAULT = 0x4Dd0136b9aabD5823cf0F65d89e8fB882C660885;

    CeloGdAntSeedVault vault;
    ICfa cfa;

    address user = makeAddr("user");
    address buyer = makeAddr("buyer");
    address liquidator = makeAddr("liquidator");

    // ~30,000 G$ per 30 days, comfortably above the $1 monthly minimum at the current price.
    int96 constant FLOW_RATE = 11574074074074074;

    function setUp() public {
        string memory rpc = vm.envOr("CELO_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        vault = CeloGdAntSeedVault(PROD_VAULT);
        cfa = ICfa(HOST.getAgreementClass(keccak256("org.superfluid-finance.agreements.ConstantFlowAgreement.v1")));

        // Swap in the implementation under test; the proxy keeps its storage and its SuperApp registration.
        CeloGdAntSeedVault impl = new CeloGdAntSeedVault(address(GD));
        vm.prank(vault.owner());
        vault.upgradeToAndCall(address(impl), "");
    }

    /// @dev The vault holds real user G$, so borrow from it to fund the test account.
    function _fund(address to, uint256 amount) internal {
        vm.prank(address(vault));
        GD.transfer(to, amount);
    }

    function _createFlow(address sender, address buyer_) internal {
        vm.prank(sender);
        HOST.callAgreement(address(cfa), abi.encodeCall(ICfa.createFlow, (address(GD), address(vault), FLOW_RATE, new bytes(0))), abi.encode(buyer_));
    }

    // --- upgrade ---

    function testUpgradeKeepsProductionConfig() public view {
        require(address(vault.gdToken()) == address(GD), "gdToken");
        require(vault.superfluidHost() == address(HOST), "host");
        require(vault.cfaV1() == address(cfa), "cfa");
        require(vault.minFirstDepositUsd() == 1e18, "min deposit");
        require(vault.gdUsdPerToken(1000 ether) > 0, "live oracle quote");
        require(!HOST.isAppJailed(address(vault)), "not jailed");
    }

    // --- batchCall: approve + CALL_APP_ACTION -> depositFromAction ---

    function testBatchCallApproveAndDepositFromAction() public {
        uint256 amount = 20_000 ether; // ~$2.2, above the $1 first-deposit minimum
        _fund(user, amount);
        uint256 vaultBefore = GD.balanceOf(address(vault));

        ISuperfluidHost.Operation[] memory ops = new ISuperfluidHost.Operation[](2);
        ops[0] = ISuperfluidHost.Operation(OP_ERC20_APPROVE, address(GD), abi.encode(address(vault), amount));
        // Trailing empty `bytes` is the ctx placeholder the Host replaces with the real ctx.
        ops[1] = ISuperfluidHost.Operation(
            OP_CALL_APP_ACTION,
            address(vault),
            abi.encodeCall(CeloGdAntSeedVault.depositFromAction, (amount, abi.encode(buyer), new bytes(0)))
        );

        vm.expectEmit(true, true, false, true, address(vault));
        emit GdDeposited(user, buyer, amount, abi.encode(buyer));
        vm.prank(user);
        HOST.batchCall(ops);

        require(GD.balanceOf(user) == 0, "user paid");
        require(GD.balanceOf(address(vault)) == vaultBefore + amount, "vault received");
        require(vault.totalDepositedGd(user) == amount, "deposit recorded under the batch sender");
        require(!HOST.isAppJailed(address(vault)), "not jailed");
    }

    function testBatchCallDepositRejectsMissingBuyer() public {
        uint256 amount = 20_000 ether;
        _fund(user, amount);

        ISuperfluidHost.Operation[] memory ops = new ISuperfluidHost.Operation[](2);
        ops[0] = ISuperfluidHost.Operation(OP_ERC20_APPROVE, address(GD), abi.encode(address(vault), amount));
        ops[1] = ISuperfluidHost.Operation(
            OP_CALL_APP_ACTION,
            address(vault),
            abi.encodeCall(CeloGdAntSeedVault.depositFromAction, (amount, new bytes(0), new bytes(0)))
        );

        vm.prank(user);
        vm.expectRevert();
        HOST.batchCall(ops);
        require(GD.balanceOf(user) == amount, "batch is atomic");
    }

    // --- real CFA create / update / delete ---

    function testCfaCreateUpdateDeleteLifecycle() public {
        _fund(user, 300_000 ether);
        uint256 t0 = block.timestamp;

        // create: buyer comes from the Superfluid userData
        vm.expectEmit(true, true, false, true, address(vault));
        emit StreamUpdated(user, buyer, FLOW_RATE, uint256(uint96(FLOW_RATE)) * 30 days, 0);
        _createFlow(user, buyer);
        require(vault.streamBuyer(user) == buyer, "buyer recorded");
        (, int96 rate, , ) = cfa.getFlow(address(GD), user, address(vault));
        require(rate == FLOW_RATE, "flow open");

        // update: the stored buyer is credited, whatever userData says
        vm.warp(t0 + 1 days);
        int96 newRate = FLOW_RATE * 2;
        vm.expectEmit(true, true, false, true, address(vault));
        emit StreamUpdated(user, buyer, newRate, uint256(uint96(newRate)) * 30 days, uint256(uint96(FLOW_RATE)) * 1 days);
        vm.prank(user);
        HOST.callAgreement(
            address(cfa),
            abi.encodeCall(ICfa.updateFlow, (address(GD), address(vault), newRate, new bytes(0))),
            abi.encode(makeAddr("someoneElse"))
        );
        require(vault.streamBuyer(user) == buyer, "buyer unchanged by update userData");

        // delete: reports the final window and never jails the app
        vm.warp(t0 + 3 days);
        vm.expectEmit(true, true, false, true, address(vault));
        emit StreamUpdated(user, buyer, 0, 0, uint256(uint96(newRate)) * 2 days);
        vm.prank(user);
        HOST.callAgreement(address(cfa), abi.encodeCall(ICfa.deleteFlow, (address(GD), user, address(vault), new bytes(0))), "");

        (, rate, , ) = cfa.getFlow(address(GD), user, address(vault));
        require(rate == 0, "flow closed");
        require(!HOST.isAppJailed(address(vault)), "termination did not jail the app");
    }

    function testCfaCreateWithoutBuyerUserDataReverts() public {
        _fund(user, 300_000 ether);
        vm.prank(user);
        vm.expectRevert();
        HOST.callAgreement(address(cfa), abi.encodeCall(ICfa.createFlow, (address(GD), address(vault), FLOW_RATE, new bytes(0))), "");
    }

    function testCfaCreateBelowMonthlyMinimumReverts() public {
        _fund(user, 300_000 ether);
        vm.prank(user);
        vm.expectRevert();
        HOST.callAgreement(address(cfa), abi.encodeCall(ICfa.createFlow, (address(GD), address(vault), int96(1e9), new bytes(0))), abi.encode(buyer));
    }

    // --- termination must never jail the app ---

    /// @dev A stream whose sender ran dry is deleted by a third party; the callback must still succeed.
    function testLiquidationOfInsolventStreamDoesNotJailApp() public {
        _fund(user, 40_000 ether); // ~40 days of flow
        uint256 t0 = block.timestamp;
        _createFlow(user, buyer);

        vm.warp(t0 + 60 days);
        vm.prank(liquidator);
        HOST.callAgreement(address(cfa), abi.encodeCall(ICfa.deleteFlow, (address(GD), user, address(vault), new bytes(0))), "");

        (, int96 rate, , ) = cfa.getFlow(address(GD), user, address(vault));
        require(rate == 0, "stream liquidated");
        require(!HOST.isAppJailed(address(vault)), "liquidation did not jail the app");
    }

    /// @dev Streams opened before `streamBuyer` was tracked have no stored buyer; closing them must not revert.
    function testTerminationOfStreamWithoutRecordedBuyerDoesNotJailApp() public {
        _fund(user, 300_000 ether);
        _createFlow(user, buyer);
        stdstore.target(address(vault)).sig(vault.streamBuyer.selector).with_key(user).checked_write(address(0));
        require(vault.streamBuyer(user) == address(0), "buyer cleared");

        vm.warp(block.timestamp + 1 days);
        vm.prank(user);
        HOST.callAgreement(address(cfa), abi.encodeCall(ICfa.deleteFlow, (address(GD), user, address(vault), new bytes(0))), "");

        (, int96 rate, , ) = cfa.getFlow(address(GD), user, address(vault));
        require(rate == 0, "stream closed");
        require(!HOST.isAppJailed(address(vault)), "termination without buyer did not jail the app");
    }

    /// @dev Owner re-points the agreement while a stream is open; closing the old stream must not jail the app.
    function testTerminationAfterAgreementConfigChangeDoesNotJailApp() public {
        _fund(user, 300_000 ether);
        _createFlow(user, buyer);

        vm.prank(vault.owner());
        vault.setSuperfluidConfig(address(HOST), address(0xBEEF));

        vm.warp(block.timestamp + 1 days);
        vm.prank(user);
        HOST.callAgreement(address(cfa), abi.encodeCall(ICfa.deleteFlow, (address(GD), user, address(vault), new bytes(0))), "");

        require(!HOST.isAppJailed(address(vault)), "termination after config change did not jail the app");
    }
}
