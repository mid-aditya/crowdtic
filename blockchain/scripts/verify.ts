import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const latestPath = path.join(__dirname, "..", "deployments", "latest.json");
  if (!fs.existsSync(latestPath)) {
    console.error("No deployment found. Run deploy.ts first.");
    process.exit(1);
  }
  const deployment = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  console.log("Verifying on network:", network.name, "(chainId:", deployment.network, ")");

  const contracts = deployment.contracts as Record<string, string>;

  for (const [name, address] of Object.entries(contracts)) {
    console.log(`Verifying ${name} at ${address}...`);
    try {
      await (ethers as any).verify.verify({
        address,
        constructorArguments: name === "TicketMarketplace" ? [contracts.TicketNFT] : [],
      });
      console.log(`  Verified ✓`);
    } catch (e: any) {
      console.log(`  Verification failed (may already be verified): ${e.message?.slice(0, 100)}`);
    }
  }
  console.log("\nDone.");
}

main().catch(console.error);
