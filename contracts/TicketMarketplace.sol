// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/PullPayment.sol";
import "./interfaces/ITicketNFT.sol";

/// @title TicketMarketplace
/// @notice Secondary market for ticket resale.
///         Enforces max resale price (e.g. 120% face value) and auto-distributes
///         royalties to organizer on every secondary sale.
contract TicketMarketplace is Ownable, ReentrancyGuard, PullPayment {
    // ── Config ─────────────────────────────────────────────────────────────
    /// @notice Basis points for organizer royalty (e.g. 1000 = 10%)
    uint256 public constant BPS = 10_000;
    uint256 public organizerRoyaltyBps = 1000; // default 10%

    // ── State ─────────────────────────────────────────────────────────────
    IERC721    public ticketNFT;
    ITicketNFT public ticketNFTView;

    struct Listing {
        address seller;
        uint256 price;   // in wei
        uint256 tokenId;
    }

    /// @notice tokenId → active listing
    mapping(uint256 => Listing) public listings;

    /// @notice Track if a listing was ever created (for cleanup)
    mapping(uint256 => bool) public hasListing;

    // ── Events ─────────────────────────────────────────────────────────────
    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event Delisted(uint256 indexed tokenId);
    event Sold(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed buyer,
        uint256 price,
        uint256 royaltyPaid
    );

    // ── Errors ─────────────────────────────────────────────────────────────
    error PriceAboveCeiling(uint256 price, uint256 ceiling);
    error NotListed(uint256 tokenId);
    error NotTokenOwner();
    error ListingNotOwnedBySeller();
    error TransferFailed();
    error ZeroPrice();

    // ── Init ───────────────────────────────────────────────────────────────
    constructor(address _ticketNFT) Ownable(msg.sender) {
        ticketNFT     = IERC721(_ticketNFT);
        ticketNFTView = ITicketNFT(_ticketNFT);
    }

    // ── Listing ───────────────────────────────────────────────────────────
    /// @notice List a ticket for resale. Price must be ≤ maxResalePrice from NFT.
    /// @param tokenId The ticket to list
    /// @param price Asking price in wei
    function list(uint256 tokenId, uint256 price) external nonReentrant {
        if (price == 0) revert ZeroPrice();
        address owner = ticketNFT.ownerOf(tokenId);
        if (owner != msg.sender) revert NotTokenOwner();

        uint256 ceiling = ticketNFTView.getMaxResalePrice(tokenId);
        if (price > ceiling) revert PriceAboveCeiling(price, ceiling);

        ticketNFT.transferFrom(owner, address(this), tokenId);

        listings[tokenId] = Listing(msg.sender, price, tokenId);
        hasListing[tokenId] = true;

        emit Listed(tokenId, msg.sender, price);
    }

    /// @notice Cancel a listing and return ticket to seller
    function delist(uint256 tokenId) external nonReentrant {
        if (!hasListing[tokenId]) revert NotListed(tokenId);
        Listing memory l = listings[tokenId];
        if (l.seller != msg.sender && msg.sender != owner()) revert ListingNotOwnedBySeller();

        delete listings[tokenId];
        delete hasListing[tokenId];

        ticketNFT.transferFrom(address(this), l.seller, tokenId);

        emit Delisted(tokenId);
    }

    // ── Buying ─────────────────────────────────────────────────────────────
    /// @notice Buy a listed ticket. Royalty sent to organizer automatically.
    function buy(uint256 tokenId) external payable nonReentrant nonReentrant {
        if (!hasListing[tokenId]) revert NotListed(tokenId);

        Listing memory l = listings[tokenId];
        if (msg.value < l.price) revert TransferFailed();

        uint256 royalty = (l.price * organizerRoyaltyBps) / BPS;

        // Store seller payout (PullPayment pattern — prevents reentrancy)
        _asyncTransfer(l.seller, l.price - royalty);

        // Store organizer royalty
        _asyncTransfer(owner(), royalty);

        // Transfer NFT to buyer
        ticketNFT.transferFrom(address(this), msg.sender, tokenId);

        delete listings[tokenId];
        delete hasListing[tokenId];

        // Refund overpayment
        if (msg.value > l.price) {
            payable(msg.sender).transfer(msg.value - l.price);
        }

        emit Sold(tokenId, l.seller, msg.sender, l.price, royalty);
    }

    // ── View ───────────────────────────────────────────────────────────────
    function getListing(uint256 tokenId) external view returns (Listing memory) {
        return listings[tokenId];
    }

    function isListed(uint256 tokenId) external view returns (bool) {
        return hasListing[tokenId];
    }

    // ── Admin ─────────────────────────────────────────────────────────────
    function setOrganizerRoyaltyBps(uint256 bps) external onlyOwner {
        if (bps > BPS) revert TransferFailed(); // sanity: can't exceed 100%
        organizerRoyaltyBps = bps;
    }

    function withdrawPayments(address payable payee) external override {
        super.withdrawPayments(payee);
    }
}
