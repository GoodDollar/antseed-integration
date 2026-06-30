// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {CeloGdAntSeedVault} from "../src/CeloGdAntSeedVault.sol";
import {AntseedBuyerOperator} from "../src/AntseedBuyerOperator.sol";

contract Deploy is Script {
    struct Config {
        address owner;
        address gdToken;
        address superfluidHost;
        address cfaV1;
        address antseedRegistry;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        Config memory config = _loadConfig();

        vm.startBroadcast(deployerKey);

        (CeloGdAntSeedVault vaultImpl, ERC1967Proxy vaultProxy) = _deployVault(config);
        (AntseedBuyerOperator opImpl, ERC1967Proxy opProxy) = _deployOperator(config);

        vm.stopBroadcast();

        _writeDeploymentJson(vaultImpl, vaultProxy, opImpl, opProxy);
    }

    function _loadConfig() private view returns (Config memory config) {
        config.owner = vm.envAddress("OWNER_ADDRESS");
        config.gdToken = vm.envAddress("GD_TOKEN");
        config.superfluidHost = vm.envAddress("SUPERFLUID_HOST");
        config.cfaV1 = vm.envAddress("CFA_V1");
        config.antseedRegistry = vm.envAddress("ANTSEED_REGISTRY");
    }

    function _deployVault(Config memory config)
        private
        returns (CeloGdAntSeedVault vaultImpl, ERC1967Proxy vaultProxy)
    {
        bytes memory vaultImplInitCode = abi.encodePacked(
            type(CeloGdAntSeedVault).creationCode,
            abi.encode(config.gdToken)
        );
        bytes32 vaultImplSalt = keccak256(vaultImplInitCode);
        vaultImpl = new CeloGdAntSeedVault{salt: vaultImplSalt}(config.gdToken);

        bytes memory vaultInitData = abi.encodeCall(
            CeloGdAntSeedVault.initialize,
            (config.owner, config.superfluidHost, config.cfaV1)
        );
        vaultProxy = new ERC1967Proxy{salt: keccak256("CELOGD_VAULT")}(address(vaultImpl), vaultInitData);
    }

    function _deployOperator(Config memory config)
        private
        returns (AntseedBuyerOperator opImpl, ERC1967Proxy opProxy)
    {
        bytes memory opImplInitCode = abi.encodePacked(
            type(AntseedBuyerOperator).creationCode,
            abi.encode(config.antseedRegistry)
        );
        bytes32 opImplSalt = keccak256(opImplInitCode);
        opImpl = new AntseedBuyerOperator{salt: opImplSalt}(config.antseedRegistry);

        bytes memory opInitData = abi.encodeCall(AntseedBuyerOperator.initialize, (config.owner));
        opProxy = new ERC1967Proxy{salt: keccak256("ANTSEED_VAULT")}(address(opImpl), opInitData);
    }

    function _writeDeploymentJson(
        CeloGdAntSeedVault vaultImpl,
        ERC1967Proxy vaultProxy,
        AntseedBuyerOperator opImpl,
        ERC1967Proxy opProxy
    ) private {
        string memory json = "deploy";
        vm.serializeAddress(json, "vaultImplementation", address(vaultImpl));
        vm.serializeAddress(json, "vaultProxy", address(vaultProxy));
        vm.serializeAddress(json, "operatorImplementation", address(opImpl));
        string memory finalJson = vm.serializeAddress(json, "operatorProxy", address(opProxy));
        vm.writeJson(finalJson, "./deploy-output.json");
    }
}
