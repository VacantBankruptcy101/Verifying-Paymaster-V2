// test/VerifyingPaymaster.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ─────────────────────────────────────────────────────────────
//  Minimal EntryPoint mock (v0.7 interface)
// ─────────────────────────────────────────────────────────────
const ENTRY_POINT_ABI = [
  "function depositTo(address account) payable",
  "function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount)",
  "function balanceOf(address account) view returns (uint256)",
];

const ENTRY_POINT_BYTECODE = `
// (deployed via a mock contract in tests)
`;

// We deploy a simple mock EntryPoint
const MockEntryPointSource = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;
contract MockEntryPoint {
    mapping(address => uint256) public deposits;
    function depositTo(address account) external payable { deposits[account] += msg.value; }
    function withdrawTo(address payable to, uint256 amount) external { 
        deposits[msg.sender] -= amount; 
        to.transfer(amount); 
    }
    function balanceOf(address account) external view returns (uint256) { return deposits[account]; }
    // Simulate calling validatePaymasterUserOp
    function callValidate(
        address paymaster,
        bytes calldata userOpEncoded,
        bytes32 userOpHash,
        uint256 maxCost
    ) external returns (bytes memory context, uint256 validationData) {
        (bool ok, bytes memory ret) = paymaster.call(
            abi.encodeWithSignature(
                "validatePaymasterUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32,uint256)",
                userOpEncoded, userOpHash, maxCost
            )
        );
        require(ok, "validate call failed");
        return abi.decode(ret, (bytes, uint256));
    }
    receive() external payable {}
}
`;

describe("VerifyingPaymaster", function () {
  // ── Fixture ────────────────────────────────────────────────
  async function deployFixture() {
    const [owner, signer, user, attacker] = await ethers.getSigners();

    // Deploy mock EntryPoint
    const MockEP = await ethers.getContractFactory("MockEntryPoint");
    const entryPoint = await MockEP.deploy();

    // Deploy Paymaster
    const Paymaster = await ethers.getContractFactory("VerifyingPaymaster");
    const pm = await Paymaster.deploy(
      await entryPoint.getAddress(),
      signer.address,
      ethers.parseEther("1") // 1 ETH daily budget
    );

    // Seed deposit
    await pm.deposit({ value: ethers.parseEther("0.5") });

    return { pm, entryPoint, owner, signer, user, attacker };
  }

  // ── Deployment ─────────────────────────────────────────────
  describe("Deployment", function () {
    it("sets the correct owner", async function () {
      const { pm, owner } = await loadFixture(deployFixture);
      expect(await pm.owner()).to.equal(owner.address);
    });

    it("registers initial signer", async function () {
      const { pm, signer } = await loadFixture(deployFixture);
      expect(await pm.signers(signer.address)).to.be.true;
    });

    it("records correct daily budget", async function () {
      const { pm } = await loadFixture(deployFixture);
      expect(await pm.dailyGlobalBudget()).to.equal(ethers.parseEther("1"));
    });

    it("reflects EntryPoint deposit", async function () {
      const { pm } = await loadFixture(deployFixture);
      // Mock EP just stores it
      expect(await pm.getDeposit()).to.equal(ethers.parseEther("0.5"));
    });
  });

  // ── Access Control ──────────────────────────────────────────
  describe("Access control", function () {
    it("prevents non-owner from adding signer", async function () {
      const { pm, attacker } = await loadFixture(deployFixture);
      await expect(
        pm.connect(attacker).setSigner(attacker.address, true)
      ).to.be.revertedWithCustomError(pm, "OwnableUnauthorizedAccount");
    });

    it("prevents non-owner from pausing", async function () {
      const { pm, attacker } = await loadFixture(deployFixture);
      await expect(pm.connect(attacker).setPaused(true)).to.be.revertedWithCustomError(
        pm,
        "OwnableUnauthorizedAccount"
      );
    });

    it("prevents non-entrypoint from calling validatePaymasterUserOp", async function () {
      const { pm, attacker } = await loadFixture(deployFixture);
      // Build a dummy packed userOp
      const dummyOp = {
        sender: attacker.address,
        nonce: 0,
        initCode: "0x",
        callData: "0x",
        accountGasLimits: ethers.ZeroHash,
        preVerificationGas: 0,
        gasFees: ethers.ZeroHash,
        paymasterAndData: "0x",
        signature: "0x",
      };
      await expect(
        pm.connect(attacker).validatePaymasterUserOp(dummyOp, ethers.ZeroHash, 0)
      ).to.be.revertedWithCustomError(pm, "OnlyEntryPoint");
    });
  });

  // ── Token Configuration ────────────────────────────────────
  describe("Token configuration", function () {
    it("allows owner to add an ERC-20 token", async function () {
      const { pm, owner } = await loadFixture(deployFixture);
      const fakeToken = ethers.Wallet.createRandom().address;
      await pm.connect(owner).configureToken(fakeToken, true, ethers.parseUnits("3000", 18), 6);
      const cfg = await pm.acceptedTokens(fakeToken);
      expect(cfg.accepted).to.be.true;
      expect(cfg.decimals).to.equal(6);
    });

    it("allows owner to revoke a token", async function () {
      const { pm, owner } = await loadFixture(deployFixture);
      const fakeToken = ethers.Wallet.createRandom().address;
      await pm.connect(owner).configureToken(fakeToken, true, 1n, 18);
      await pm.connect(owner).configureToken(fakeToken, false, 0n, 0);
      const cfg = await pm.acceptedTokens(fakeToken);
      expect(cfg.accepted).to.be.false;
    });
  });

  // ── Budget Limits ──────────────────────────────────────────
  describe("Budget enforcement", function () {
    it("tracks global remaining budget", async function () {
      const { pm } = await loadFixture(deployFixture);
      const remaining = await pm.getRemainingDailyBudget();
      expect(remaining).to.equal(ethers.parseEther("1"));
    });

    it("reports unlimited budget when dailyGlobalBudget = 0", async function () {
      const { pm, owner } = await loadFixture(deployFixture);
      await pm.connect(owner).setDailyBudget(0);
      const remaining = await pm.getRemainingDailyBudget();
      expect(remaining).to.equal(ethers.MaxUint256);
    });

    it("allows owner to set per-user budget", async function () {
      const { pm, owner, user } = await loadFixture(deployFixture);
      await pm.connect(owner).setUserBudget(user.address, ethers.parseEther("0.01"));
      expect(await pm.userGasBudget(user.address)).to.equal(ethers.parseEther("0.01"));
    });
  });

  // ── Pause ──────────────────────────────────────────────────
  describe("Pause", function () {
    it("can be paused and unpaused by owner", async function () {
      const { pm, owner } = await loadFixture(deployFixture);
      await pm.connect(owner).setPaused(true);
      expect(await pm.paused()).to.be.true;
      await pm.connect(owner).setPaused(false);
      expect(await pm.paused()).to.be.false;
    });
  });

  // ── Withdraw ───────────────────────────────────────────────
  describe("Withdraw", function () {
    it("allows owner to withdraw tokens", async function () {
      const { pm, owner } = await loadFixture(deployFixture);
      // Deploy a simple ERC-20 mock and send some to paymaster
      const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
      const token = await ERC20Mock.deploy("TestUSDC", "USDC", 6);
      await token.mint(await pm.getAddress(), ethers.parseUnits("100", 6));
      const before = await token.balanceOf(owner.address);
      await pm.connect(owner).withdrawTokens(
        await token.getAddress(),
        owner.address,
        ethers.parseUnits("100", 6)
      );
      const after = await token.balanceOf(owner.address);
      expect(after - before).to.equal(ethers.parseUnits("100", 6));
    });
  });
});
