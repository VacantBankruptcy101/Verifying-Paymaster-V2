// scripts/deploy.js
const { ethers } = require("hardhat");

// ERC-4337 EntryPoint v0.7 (same address on all EVM chains)
const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // ── Configuration ────────────────────────────────────────────────────────
  const SIGNER_ADDRESS = deployer.address;          // replace with a dedicated hot-signer
  const DAILY_BUDGET_ETH = "0.5";                   // 0.5 ETH per day global cap
  const INITIAL_DEPOSIT_ETH = "0.1";               // seed EntryPoint deposit

  // Accepted ERC-20 tokens on Sepolia (replace with real addresses on mainnet)
  const TOKENS = {
    USDC: {
      address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",   // Sepolia USDC
      pricePerEth: ethers.parseUnits("3000", 18),              // 3000 USDC = 1 ETH
      decimals: 6,
    },
    DAI: {
      address: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357",   // Sepolia DAI
      pricePerEth: ethers.parseUnits("3000", 18),              // 3000 DAI = 1 ETH
      decimals: 18,
    },
  };
  // ─────────────────────────────────────────────────────────────────────────

  const PaymasterFactory = await ethers.getContractFactory("VerifyingPaymaster");
  const paymaster = await PaymasterFactory.deploy(
    ENTRY_POINT_V07,
    SIGNER_ADDRESS,
    ethers.parseEther(DAILY_BUDGET_ETH)
  );
  await paymaster.waitForDeployment();

  const address = await paymaster.getAddress();
  console.log("\n✅  VerifyingPaymaster deployed to:", address);

  // Configure tokens
  console.log("\nConfiguring accepted tokens...");
  for (const [symbol, cfg] of Object.entries(TOKENS)) {
    const tx = await paymaster.configureToken(
      cfg.address,
      true,
      cfg.pricePerEth,
      cfg.decimals
    );
    await tx.wait();
    console.log(`  ✓ ${symbol} accepted at ${cfg.address}`);
  }

  // Initial deposit
  console.log("\nDepositing initial ETH to EntryPoint...");
  const depositTx = await paymaster.deposit({ value: ethers.parseEther(INITIAL_DEPOSIT_ETH) });
  await depositTx.wait();
  console.log(`  ✓ Deposited ${INITIAL_DEPOSIT_ETH} ETH`);

  const deposit = await paymaster.getDeposit();
  console.log("  EntryPoint balance:", ethers.formatEther(deposit), "ETH");

  // Summary
  console.log("\n──────────────────────────────────────────────");
  console.log("Deployment Summary");
  console.log("──────────────────────────────────────────────");
  console.log("Contract:     ", address);
  console.log("EntryPoint:   ", ENTRY_POINT_V07);
  console.log("Signer:       ", SIGNER_ADDRESS);
  console.log("Daily budget: ", DAILY_BUDGET_ETH, "ETH");
  console.log("EP deposit:   ", ethers.formatEther(deposit), "ETH");
  console.log("──────────────────────────────────────────────");

  // Verify on Etherscan (if API key is set)
  if (process.env.ETHERSCAN_API_KEY) {
    console.log("\nWaiting for block confirmations before verification...");
    await paymaster.deploymentTransaction().wait(5);
    await hre.run("verify:verify", {
      address,
      constructorArguments: [
        ENTRY_POINT_V07,
        SIGNER_ADDRESS,
        ethers.parseEther(DAILY_BUDGET_ETH),
      ],
    });
    console.log("✅  Verified on Etherscan");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
