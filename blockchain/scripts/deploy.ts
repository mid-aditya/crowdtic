import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  // ── 1. Deploy IdentityRegistry first (no dependencies) ─────────────────
  console.log("\n[1] Deploying IdentityRegistry...");
  const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
  const identityRegistry = await IdentityRegistry.deploy();
  await identityRegistry.waitForDeployment();
  const identityRegistryAddr = await identityRegistry.getAddress();
  console.log("  IdentityRegistry:", identityRegistryAddr);

  // ── 2. Deploy TicketNFT ───────────────────────────────────────────────
  console.log("\n[2] Deploying TicketNFT...");
  const TicketNFT = await ethers.getContractFactory("TicketNFT");
  const ticketNFT = await TicketNFT.deploy();
  await ticketNFT.waitForDeployment();
  const ticketNFTAddr = await ticketNFT.getAddress();
  console.log("  TicketNFT:", ticketNFTAddr);

  // Configure TicketNFT with related contracts
  await (await ticketNFT.setIdentityRegistry(identityRegistryAddr)).wait();
  console.log("  IdentityRegistry wired to TicketNFT");

  // ── 3. Deploy TicketMarketplace ───────────────────────────────────────
  console.log("\n[3] Deploying TicketMarketplace...");
  const TicketMarketplace = await ethers.getContractFactory("TicketMarketplace");
  const marketplace = await TicketMarketplace.deploy(ticketNFTAddr);
  await marketplace.waitForDeployment();
  const marketplaceAddr = await marketplace.getAddress();
  console.log("  TicketMarketplace:", marketplaceAddr);

  // Configure TicketNFT with marketplace
  await (await ticketNFT.setMarketplace(marketplaceAddr)).wait();
  console.log("  Marketplace wired to TicketNFT");

  // Transfer marketplace ownership to deployer (organizer)
  await (await marketplace.transferOwnership(deployer.address)).wait();

  // ── 4. Deploy CrowdTicToken ──────────────────────────────────────────
  console.log("\n[4] Deploying CrowdTicToken...");
  const CrowdTicToken = await ethers.getContractFactory("CrowdTicToken");
  const crowdTicToken = await CrowdTicToken.deploy();
  await crowdTicToken.waitForDeployment();
  const crowdTicTokenAddr = await crowdTicToken.getAddress();
  console.log("  CrowdTicToken:", crowdTicTokenAddr);

  // ── 5. Save deployment addresses ─────────────────────────────────────
  const deployment = {
    network: (await ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      IdentityRegistry: identityRegistryAddr,
      TicketNFT: ticketNFTAddr,
      TicketMarketplace: marketplaceAddr,
      CrowdTicToken: crowdTicTokenAddr,
    },
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

  const fileName = `deploy-${deployment.network}-${Date.now()}.json`;
  fs.writeFileSync(path.join(deploymentsDir, fileName), JSON.stringify(deployment, null, 2));
  fs.writeFileSync(
    path.join(deploymentsDir, "latest.json"),
    JSON.stringify(deployment, null, 2)
  );
  console.log(`\nSaved to deployments/${fileName}`);

  // ── 6. Print integration guide ────────────────────────────────────────
  console.log("\n========================================");
  console.log("  DEPLOYMENT SUCCESSFUL");
  console.log("========================================");
  console.log(`  TicketNFT:      ${ticketNFTAddr}`);
  console.log(`  Marketplace:    ${marketplaceAddr}`);
  console.log(`  IdentityReg:    ${identityRegistryAddr}`);
  console.log(`  CrowdTicToken: ${crowdTicTokenAddr}`);
  console.log("");
  console.log("  Next: wire these addresses into your booking-service");
  console.log("  Go env vars:");
  console.log(`    NFT_CONTRACT_ADDRESS=${ticketNFTAddr}`);
  console.log(`    MARKETPLACE_ADDRESS=${marketplaceAddr}`);
  console.log(`    IDENTITY_REGISTRY=${identityRegistryAddr}`);
  console.log(`    CHAIN_RPC_URL=${process.env.BASE_SEPOLIA_RPC_URL || "http://localhost:8545"}`);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
