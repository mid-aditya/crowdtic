/**
 * Example: Mint a ticket NFT after off-chain commit succeeds.
 * Run AFTER deploy.ts — uses the latest deployment.
 * 
 * Usage:
 *   npx hardhat run scripts/examples/mint-ticket.ts --network localhost
 *   npx hardhat run scripts/examples/mint-ticket.ts --network base-sepolia
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const latestPath = path.join(__dirname, "..", "..", "deployments", "latest.json");
  const deployment = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  const { TicketNFT } = deployment.contracts;

  const nft = await ethers.getContractAt("TicketNFT", TicketNFT);
  const [owner, buyer] = await ethers.getSigners();

  // Example: mint for a Mega Concert event, VIP-0001 seat
  const eventId = ethers.keccak256(ethers.toUtf8Bytes("mega-concert-2026"));
  const seatNumber = 1;
  const faceValue = ethers.parseEther("0.05"); // 0.05 ETH (approx Rp 1.5M)
  const kycRequired = true;
  const metadataURI = "ipfs://QmXxx.../ticket-mega-vip-0001.json"; // IPFS CID

  console.log("Minting ticket...");
  const tx = await nft.connect(owner).mintTicket(
    buyer.address,
    eventId,
    seatNumber,
    faceValue,
    kycRequired,
    metadataURI
  );
  const receipt = await tx.wait();
  
  // Extract tokenId from Transfer event
  const transferEvent = receipt.logs.find(
    (l: any) => l.fragment?.name === "Transfer"
  );
  const tokenId = transferEvent?.args?.tokenId;
  console.log(`Minted tokenId: ${tokenId}`);
  console.log(`TicketNFT: https://sepolia.basescan.org/token/${TicketNFT}`);
  console.log(`View NFT: https://sepolia.basescan.org/token/${TicketNFT}?a=${tokenId}`);
}

main().catch(console.error);
