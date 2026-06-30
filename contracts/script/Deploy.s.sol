// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {CeloGdAntSeedVault} from "../src/CeloGdAntSeedVault.sol";
import {AntseedBuyerOperator} from "../src/AntseedBuyerOperator.sol";

/// @notice Deploy CeloGdAntSeedVault on Celo.
/// forge script script/Deploy.s.sol:DeployCelo --rpc-url $CELO_RPC_URL --broadcast --verify --etherscan-api-key $CELOSCAN_API_KEY -vvvv
contract DeployCelo is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = vm.envAddress("OWNER_ADDRESS");
        address gdToken = vm.envAddress("GD_TOKEN");
        address superfluidHost = vm.envAddress("SUPERFLUID_HOST");
        address cfaV1 = vm.envAddress("CFA_V1");

        // Pre-compute CREATE2 addresses so we can skip already-deployed contracts.
        bytes memory vaultImplInitCode = abi.encodePacked(
            type(CeloGdAntSeedVault).creationCode,
            abi.encode(gdToken)
        );
        bytes32 vaultImplSalt = keccak256(vaultImplInitCode);
        address vaultImplAddr = vm.computeCreate2Address(vaultImplSalt, keccak256(vaultImplInitCode), deployer);

        bytes memory vaultInitData = abi.encodeCall(
            CeloGdAntSeedVault.initialize,
            (owner, superfluidHost, cfaV1)
        );
        bytes32 vaultProxySalt = keccak256("CELOGD_VAULT_PROD");
        bytes memory vaultProxyInitCode = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(vaultImplAddr, vaultInitData)
        );
        address vaultProxyAddr = vm.computeCreate2Address(vaultProxySalt, keccak256(vaultProxyInitCode), deployer);

        vm.startBroadcast(deployerKey);

        CeloGdAntSeedVault vaultImpl = vaultImplAddr.code.length == 0
            ? new CeloGdAntSeedVault{salt: vaultImplSalt}(gdToken)
            : CeloGdAntSeedVault(vaultImplAddr);

        ERC1967Proxy vaultProxy = vaultProxyAddr.code.length == 0
            ? new ERC1967Proxy{salt: vaultProxySalt}(address(vaultImpl), vaultInitData)
            : ERC1967Proxy(payable(vaultProxyAddr));

        vm.stopBroadcast();

        string memory json = "deploy";
        vm.serializeAddress(json, "vaultImplementation", address(vaultImpl));
        string memory finalJson = vm.serializeAddress(json, "vaultProxy", address(vaultProxy));
        vm.writeJson(finalJson, "./deploy-celo-output.json");
    }
}

/// @notice Deploy AntseedBuyerOperator on Base.
/// forge script script/Deploy.s.sol:DeployBase --rpc-url $BASE_RPC_URL --broadcast --verify --etherscan-api-key $BASESCAN_API_KEY -vvvv
contract DeployBase is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = vm.envAddress("OWNER_ADDRESS");
        address antseedRegistry = vm.envAddress("ANTSEED_REGISTRY");

        // Pre-compute CREATE2 addresses so we can skip already-deployed contracts.
        bytes memory opImplInitCode = abi.encodePacked(
            type(AntseedBuyerOperator).creationCode,
            abi.encode(antseedRegistry)
        );
        bytes32 opImplSalt = keccak256(opImplInitCode);
        address opImplAddr = vm.computeCreate2Address(opImplSalt, keccak256(opImplInitCode), deployer);

        bytes memory opInitData = abi.encodeCall(AntseedBuyerOperator.initialize, (owner));
        bytes32 opProxySalt = keccak256("ANTSEED_VAULT_PROD");
        bytes memory opProxyInitCode = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(opImplAddr, opInitData)
        );
        address opProxyAddr = vm.computeCreate2Address(opProxySalt, keccak256(opProxyInitCode), deployer);

        vm.startBroadcast(deployerKey);

        AntseedBuyerOperator opImpl = opImplAddr.code.length == 0
            ? new AntseedBuyerOperator{salt: opImplSalt}(antseedRegistry)
            : AntseedBuyerOperator(opImplAddr);

        ERC1967Proxy opProxy = opProxyAddr.code.length == 0
            ? new ERC1967Proxy{salt: opProxySalt}(address(opImpl), opInitData)
            : ERC1967Proxy(payable(opProxyAddr));

        vm.stopBroadcast();

        string memory json = "deploy";
        vm.serializeAddress(json, "operatorImplementation", address(opImpl));
        string memory finalJson = vm.serializeAddress(json, "operatorProxy", address(opProxy));
        vm.writeJson(finalJson, "./deploy-base-output.json");
    }
}
