// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {CeloGdAntSeedVault} from "../src/CeloGdAntSeedVault.sol";
import {AntseedBuyerOperator} from "../src/AntseedBuyerOperator.sol";

/// @notice Deploy CeloGdAntSeedVault on Celo.
/// forge script script/Deploy.s.sol:DeployCelo --rpc-url $CELO_RPC_URL --broadcast --verify --etherscan-api-key $CELOSCAN_API_KEY -vvvv
contract DeployCelo is Script {
    string constant OUTPUT_FILE = "./deploy-celo-output.json";
    uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
    address deployer = vm.addr(deployerKey);
    address owner = vm.envAddress("OWNER_ADDRESS");
    address gdToken = vm.envAddress("GD_TOKEN");
    address superfluidHost = vm.envAddress("SUPERFLUID_HOST");
    address cfaV1 = vm.envAddress("CFA_V1");

    /// @dev Thin entry point: reads JSON output and skips if the proxy is already live.
    function run() external {
        // Pre-compute CREATE2 addresses so we can skip already-deployed contracts.
        bytes memory vaultImplInitCode = abi.encodePacked(type(CeloGdAntSeedVault).creationCode, abi.encode(gdToken));
        bytes32 vaultImplSalt = keccak256(vaultImplInitCode);
        address vaultImplAddr = vm.computeCreate2Address(vaultImplSalt, keccak256(vaultImplInitCode), StdConstants.CREATE2_FACTORY);

        bytes memory vaultInitData = abi.encodeCall(CeloGdAntSeedVault.initialize, (owner, superfluidHost, cfaV1));
        bytes32 vaultProxySalt = keccak256("CELOGD_VAULT_PROD");
        bytes memory vaultProxyInitCode = abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(vaultImplAddr, vaultInitData));

        vm.startBroadcast(deployerKey);

        console.log("Deploying CeloGdAntSeedVault implementation at", vaultImplAddr);
        CeloGdAntSeedVault vaultImpl = vaultImplAddr.code.length == 0
            ? new CeloGdAntSeedVault{salt: vaultImplSalt}(gdToken)
            : CeloGdAntSeedVault(vaultImplAddr);

        console.log("Deploying CeloGdAntSeedVault proxy at");
        address vaultProxyAddr = _readAddress(OUTPUT_FILE, ".vaultProxy");
        if (vaultProxyAddr != address(0) && vaultProxyAddr.code.length > 0) {
            console.log("CeloGdAntSeedVault proxy already deployed at", vaultProxyAddr, "-- skipping");
        } else {
            vaultProxyAddr = vm.computeCreate2Address(vaultProxySalt, keccak256(vaultProxyInitCode), StdConstants.CREATE2_FACTORY);
        }

        ERC1967Proxy vaultProxy = vaultProxyAddr.code.length == 0
            ? new ERC1967Proxy{salt: vaultProxySalt}(address(vaultImpl), vaultInitData)
            : ERC1967Proxy(payable(vaultProxyAddr));

        vm.stopBroadcast();

        vm.serializeAddress("deploy", "vaultImplementation", address(vaultImpl));
        string memory finalJson = vm.serializeAddress("deploy", "vaultProxy", address(vaultProxy));
        vm.writeJson(finalJson, OUTPUT_FILE);
    }

    function _readAddress(string memory path, string memory key) internal returns (address) {
        try vm.readFile(path) returns (string memory data) {
            try vm.parseJsonAddress(data, key) returns (address addr) {
                return addr;
            } catch {}
        } catch {}
        return address(0);
    }
}

/// @notice Deploy AntseedBuyerOperator on Base.
/// forge script script/Deploy.s.sol:DeployBase --rpc-url $BASE_RPC_URL --broadcast --verify --etherscan-api-key $BASESCAN_API_KEY -vvvv
contract DeployBase is Script {
    string constant OUTPUT_FILE = "./deploy-base-output.json";

    /// @dev Thin entry point: reads JSON output and skips if the proxy is already live.
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = vm.envAddress("OWNER_ADDRESS");
        address antseedRegistry = vm.envAddress("ANTSEED_REGISTRY");

        // Pre-compute CREATE2 addresses so we can skip already-deployed contracts.
        bytes memory opImplInitCode = abi.encodePacked(type(AntseedBuyerOperator).creationCode, abi.encode(antseedRegistry));
        bytes32 opImplSalt = keccak256(opImplInitCode);
        address opImplAddr = vm.computeCreate2Address(opImplSalt, keccak256(opImplInitCode), StdConstants.CREATE2_FACTORY);

        bytes memory opInitData = abi.encodeCall(AntseedBuyerOperator.initialize, (owner));
        bytes32 opProxySalt = keccak256("ANTSEED_VAULT_PROD");
        bytes memory opProxyInitCode = abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(opImplAddr, opInitData));

        address opProxyAddr = _readAddress(OUTPUT_FILE, ".operatorProxy");
        if (opProxyAddr != address(0) && opProxyAddr.code.length > 0) {
            console.log("AntseedBuyerOperator proxy already deployed at", opProxyAddr, "-- skipping");
        } else {
            opProxyAddr = vm.computeCreate2Address(opProxySalt, keccak256(opProxyInitCode), StdConstants.CREATE2_FACTORY);
        }
        vm.startBroadcast(deployerKey);

        AntseedBuyerOperator opImpl = opImplAddr.code.length == 0
            ? new AntseedBuyerOperator{salt: opImplSalt}(antseedRegistry)
            : AntseedBuyerOperator(opImplAddr);

        ERC1967Proxy opProxy = opProxyAddr.code.length == 0
            ? new ERC1967Proxy{salt: opProxySalt}(address(opImpl), opInitData)
            : ERC1967Proxy(payable(opProxyAddr));

        vm.stopBroadcast();

        vm.serializeAddress("deploy", "operatorImplementation", address(opImpl));
        string memory finalJson = vm.serializeAddress("deploy", "operatorProxy", address(opProxy));
        vm.writeJson(finalJson, OUTPUT_FILE);
    }

    function _readAddress(string memory path, string memory key) internal returns (address) {
        try vm.readFile(path) returns (string memory data) {
            try vm.parseJsonAddress(data, key) returns (address addr) {
                return addr;
            } catch {}
        } catch {}
        return address(0);
    }
}
