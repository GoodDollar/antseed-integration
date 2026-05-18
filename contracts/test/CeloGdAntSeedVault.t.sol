// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CeloGdAntSeedVault, IERC20Like} from "../src/CeloGdAntSeedVault.sol";

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

    function isWhitelisted(address account) external view returns (bool) {
        return whitelisted[account];
    }

    function getWhitelistedRoot(address account) external view returns (address) {
        return roots[account];
    }
}

contract MockCFA {
    mapping(address => int96) public flowRates;

    function setFlow(address sender, int96 flowRate) external {
        flowRates[sender] = flowRate;
    }

    function getFlow(address, address sender, address) external view returns (uint256, int96, uint256, uint256) {
        return (block.timestamp, flowRates[sender], 0, 0);
    }
}

contract UserProxy {
    MockGdToken public token;
    CeloGdAntSeedVault public vault;

    constructor(MockGdToken token_, CeloGdAntSeedVault vault_) {
        token = token_;
        vault = vault_;
    }

    function approveVault(uint256 amount) external {
        token.approve(address(vault), amount);
    }

    function deposit(uint256 amount) external {
        vault.deposit(amount, "0x01");
    }

    function transferAndCall(uint256 amount) external {
        token.transferAndCall(address(vault), amount, "0x02");
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
    HostProxy host;
    CeloGdAntSeedVault vault;
    UserProxy user;

    function setUp() public {
        token = new MockGdToken();
        superToken = new MockGdToken();
        goodId = new MockGoodID();
        cfa = new MockCFA();
        host = new HostProxy();
        vault = new CeloGdAntSeedVault(address(token), address(superToken), address(goodId), address(host), address(cfa));
        user = new UserProxy(token, vault);
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
        token.erc777Send(address(0xBEEF), address(user), address(vault), 30 ether, "0x03");
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

    function testSuperfluidCallbacksRecordMonthlyStreamForVerifiedUser() public {
        setUp();
        int96 flowRate = 38580246913580; // ~100 G$ / 30 days at 18 decimals
        cfa.setFlow(address(user), flowRate);
        host.created(vault, address(superToken), address(cfa), address(user));
        require(vault.streamFlowRate(address(user)) == flowRate, "flow recorded");
        require(vault.streamMonthlyGdAmount(address(user)) == uint256(uint96(flowRate)) * 30 days, "monthly amount recorded");
    }

    function testSuperfluidCreateRequiresGoodIDButTerminationCanClear() public {
        setUp();
        cfa.setFlow(address(user), 10);
        goodId.setWhitelisted(address(user), false);
        (bool ok,) = address(host).call(abi.encodeWithSignature(
            "created(address,address,address,address)",
            address(vault),
            address(superToken),
            address(cfa),
            address(user)
        ));
        require(!ok, "unverified stream create rejected");

        cfa.setFlow(address(user), 0);
        host.terminated(vault, address(superToken), address(cfa), address(user));
        require(vault.streamFlowRate(address(user)) == 0, "termination allowed");
    }
}
