import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("TicketNFT", function () {
  async function deploy() {
    const [organizer, buyer, scalper] = await ethers.getSigners();
    const TicketNFT = await ethers.getContractFactory("TicketNFT");
    const nft = await TicketNFT.deploy();
    await nft.waitForDeployment();
    return { nft, organizer, buyer, scalper };
  }

  it("should deploy with correct metadata", async function () {
    const { nft } = await loadFixture(deploy);
    expect(await nft.name()).to.equal("CrowdTic Ticket");
    expect(await nft.symbol()).to.equal("CTKT");
  });

  it("should mint a ticket to buyer", async function () {
    const { nft, organizer, buyer } = await loadFixture(deploy);
    const eventId = ethers.keccak256(ethers.toUtf8Bytes("mega-concert"));
    const faceValue = ethers.parseEther("0.1");

    await expect(
      nft.connect(organizer).mintTicket(
        buyer.address,
        eventId,
        1,
        faceValue,
        false,
        "ipfs://QmTest"
      )
    ).to.emit(nft, "TicketMinted");

    const totalSupply = await nft.totalSupply();
    expect(totalSupply).to.equal(1n);
    expect(await nft.ownerOf(1)).to.equal(buyer.address);
  });

  it("should prevent double-minting same seat", async function () {
    const { nft, organizer, buyer } = await loadFixture(deploy);
    const eventId = ethers.keccak256(ethers.toUtf8Bytes("mega-concert"));
    const faceValue = ethers.parseEther("0.1");

    await nft.connect(organizer).mintTicket(buyer.address, eventId, 1, faceValue, false, "ipfs://Qm1");
    await expect(
      nft.connect(organizer).mintTicket(buyer.address, eventId, 1, faceValue, false, "ipfs://Qm2")
    ).to.be.revertedWithCustomError(nft, "SeatAlreadyMinted");
  });

  it("should prevent transfer without KYC on KYC-required tickets", async function () {
    const { nft, organizer, buyer, scalper } = await loadFixture(deploy);
    const eventId = ethers.keccak256(ethers.toUtf8Bytes("mega-concert"));

    // Mint with KYC required
    await nft.connect(organizer).mintTicket(
      buyer.address, eventId, 1, ethers.parseEther("0.1"), true, "ipfs://QmTest"
    );

    // Scalper tries to buy — should fail
    await expect(
      nft.connect(buyer)["safeTransferFrom(address,address,uint256)"](
        buyer.address, scalper.address, 1
      )
    ).to.be.revertedWithCustomError(nft, "KYCRequired");
  });

  it("should allow transfer when KYC verified", async function () {
    const { nft, organizer, buyer, scalper } = await loadFixture(deploy);
    const eventId = ethers.keccak256(ethers.toUtf8Bytes("mega-concert"));

    await nft.connect(organizer).mintTicket(
      buyer.address, eventId, 1, ethers.parseEther("0.1"), true, "ipfs://QmTest"
    );

    // Verify scalper KYC
    await nft.connect(organizer).setKYCVerified(scalper.address, true);

    // Now transfer should work
    await nft.connect(buyer)["safeTransferFrom(address,address,uint256)"](
      buyer.address, scalper.address, 1
    );

    expect(await nft.ownerOf(1)).to.equal(scalper.address);
  });

  it("should burn ticket on cancel", async function () {
    const { nft, organizer, buyer } = await loadFixture(deploy);
    const eventId = ethers.keccak256(ethers.toUtf8Bytes("mega-concert"));

    await nft.connect(organizer).mintTicket(
      buyer.address, eventId, 1, ethers.parseEther("0.1"), false, "ipfs://QmTest"
    );

    await expect(nft.connect(organizer).cancelTicket(1))
      .to.emit(nft, "TicketCancelled");

    await expect(nft.ownerOf(1)).to.be.revertedWith("ERC721: invalid token ID");
  });
});

describe("TicketMarketplace", function () {
  async function deployMarket() {
    const [organizer, seller, buyer, scalper] = await ethers.getSigners();
    const TicketNFT = await ethers.getContractFactory("TicketNFT");
    const nft = await TicketNFT.deploy();
    await nft.waitForDeployment();
    const Marketplace = await ethers.getContractFactory("TicketMarketplace");
    const marketplace = await Marketplace.deploy(await nft.getAddress());
    await marketplace.waitForDeployment();

    // Mint ticket to seller
    const eventId = ethers.keccak256(ethers.toUtf8Bytes("mega-concert"));
    const faceValue = ethers.parseEther("0.05");
    await nft.connect(organizer).mintTicket(
      seller.address, eventId, 1, faceValue, false, "ipfs://QmTest"
    );

    return { nft, marketplace, organizer, seller, buyer, scalper, faceValue };
  }

  it("should list ticket at valid price", async function () {
    const { nft, marketplace, seller, faceValue } = await loadFixture(deployMarket);
    const price = faceValue; // face value = valid

    await expect(marketplace.connect(seller).list(1, price))
      .to.emit(marketplace, "Listed").withArgs(1, seller.address, price);

    expect(await nft.ownerOf(1)).to.equal(await marketplace.getAddress());
  });

  it("should reject listing above ceiling", async function () {
    const { marketplace, seller } = await loadFixture(deployMarket);
    const tooExpensive = ethers.parseEther("1.0"); // way above 120% ceiling

    await expect(marketplace.connect(seller).list(1, tooExpensive))
      .to.be.revertedWithCustomError(marketplace, "PriceAboveCeiling");
  });

  it("should complete buy with royalty split", async function () {
    const { nft, marketplace, organizer, seller, buyer, faceValue } = await loadFixture(deployMarket);
    const price = faceValue;

    await marketplace.connect(seller).list(1, price);

    // Buyer buys
    await expect(marketplace.connect(buyer).buy(1, { value: price }))
      .to.emit(marketplace, "Sold").withArgs(1, seller.address, buyer.address, price);

    expect(await nft.ownerOf(1)).to.equal(buyer.address);
  });
});
