// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/ITicketNFT.sol";

/// @title TicketNFT
/// @notice ERC-721 NFT for event tickets — minted AFTER off-chain commit succeeds.
///         One seat = one NFT. Smart contract enforces KYC, resale caps, and cancellation.
/// @dev Inherits Ownable so only the organizer (or booking-service wallet) can mint.
contract TicketNFT is ERC721, ERC721URIStorage, Ownable, ReentrancyGuard, ITicketNFT {
    // ── Data ──────────────────────────────────────────────────────────────
    uint256 private _tokenIdCounter;

    mapping(uint256 => Ticket)              public tickets;
    mapping(bytes32 => uint256)             public seatToToken; // keccak256(eventId, seatNumber) → tokenId
    mapping(address => bool)                public override isKYCVerified;
    mapping(bytes32 => bool)                public eventMinted;

    // Contract addresses
    address public marketplace;
    address public identityRegistry;

    // ── Struct (mirrors interface) ────────────────────────────────────────
    Ticket _empty;

    // ── Events ────────────────────────────────────────────────────────────
    event TicketMinted(uint256 indexed tokenId, address indexed to, bytes32 indexed eventId, uint256 seatNumber);
    event TicketCancelled(uint256 indexed tokenId);
    event TicketTransferred(uint256 indexed tokenId, address indexed from, address indexed to);
    event MarketplaceUpdated(address indexed oldMarket, address indexed newMarket);
    event IdentityRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    // ── Errors ───────────────────────────────────────────────────────────
    error SeatAlreadyMinted(bytes32 eventId, uint256 seatNumber);
    error NotMarketplace();
    error KYCRequired();
    error InvalidToken();
    error NotTicketOwner();
    error TransferLocked();

    // ── Init ──────────────────────────────────────────────────────────────
    constructor() ERC721("CrowdTic Ticket", "CTKT") Ownable(msg.sender) {}

    // ── Minting ───────────────────────────────────────────────────────────
    /// @notice Called by booking-service wallet AFTER PG commit succeeds.
    ///         This is the on-chain proof that the ticket is GENUINE.
    function mintTicket(
        address to,
        bytes32 eventId,
        uint256 seatNumber,
        uint256 faceValue,
        bool    kycRequired,
        string calldata metadataURI
    ) external override onlyOwner nonReentrant returns (uint256 tokenId) {
        bytes32 seatKey = keccak256(abi.encode(eventId, seatNumber));
        if (seatToToken[seatKey] != 0) revert SeatAlreadyMinted(eventId, seatNumber);

        tokenId = _tokenIdCounter++;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, metadataURI);

        tickets[tokenId] = Ticket({
            eventId:          eventId,
            seatNumber:       seatNumber,
            faceValue:        faceValue,
            maxResalePrice:   faceValue * 120 / 100, // 120% ceiling by default
            kycRequired:      kycRequired,
            originalOwner:    to,
            transferred:      false,
            metadataURI:      metadataURI
        });
        seatToToken[seatKey] = tokenId;
        eventMinted[keccak256(abi.encode(eventId))] = true;

        emit TicketMinted(tokenId, to, eventId, seatNumber);
    }

    /// @notice Burn NFT on cancellation/refund (called by organizer)
    function cancelTicket(uint256 tokenId) external override onlyOwner nonReentrant {
        if (!_exists(tokenId)) revert InvalidToken();
        address owner = ownerOf(tokenId);
        _burn(tokenId);
        delete tickets[tokenId];
        emit TicketCancelled(tokenId);
        // Refund event emitted — off-chain PG already handles payment reversal
    }

    /// @notice Manual KYC verification (or called by identityRegistry)
    function setKYCVerified(address user, bool status) external {
        // Only identity registry or owner can verify
        if (msg.sender != identityRegistry && msg.sender != owner()) revert NotMarketplace();
        isKYCVerified[user] = status;
    }

    /// @notice Get ticket details
    function getTicket(uint256 tokenId) external view returns (Ticket memory) {
        if (!_exists(tokenId)) revert InvalidToken();
        return tickets[tokenId];
    }

    /// @notice Update marketplace address
    function setMarketplace(address _marketplace) external onlyOwner {
        emit MarketplaceUpdated(marketplace, _marketplace);
        marketplace = _marketplace;
    }

    /// @notice Update identity registry
    function setIdentityRegistry(address _identityRegistry) external onlyOwner {
        emit IdentityRegistryUpdated(identityRegistry, _identityRegistry);
        identityRegistry = _identityRegistry;
    }

    /// @notice Get max resale price for a ticket
    function getMaxResalePrice(uint256 tokenId) external view returns (uint256) {
        if (!_exists(tokenId)) revert InvalidToken();
        return tickets[tokenId].maxResalePrice;
    }

    /// @notice Update max resale price (organizer can tighten ceiling)
    function setMaxResalePrice(uint256 tokenId, uint256 newCeiling) external onlyOwner {
        if (!_exists(tokenId)) revert InvalidToken();
        if (newCeiling < tickets[tokenId].faceValue) revert InvalidToken();
        tickets[tokenId].maxResalePrice = newCeiling;
    }

    // ── Transfer Hook ─────────────────────────────────────────────────────
    /// @dev Blocks transfer if KYC not verified on ticket that requires it.
    ///      Also prevents secondary transfer for tickets locked after settlement.
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 tokenId,
        bytes calldata /*data*/
    ) internal override {
        super._beforeTokenTransfer(from, to, tokenId);

        // Minting is always allowed
        if (from == address(0)) return;

        // Burning is always allowed (cancelTicket uses _burn)
        if (to == address(0)) return;

        // Prevent transfer if ticket locked
        if (tickets[tokenId].transferred) revert TransferLocked();

        // KYC gate for tickets that require it
        if (tickets[tokenId].kycRequired && !isKYCVerified[to]) revert KYCRequired();

        // Update transferred flag on first secondary-market transfer
        if (from != tickets[tokenId].originalOwner) {
            tickets[tokenId].transferred = true;
        }

        emit TicketTransferred(tokenId, from, to);
    }

    // ── URI ────────────────────────────────────────────────────────────────
    function tokenURI(uint256 tokenId)
        public view override(ERC721, ERC721URIStorage) returns (string memory)
    {
        if (!_exists(tokenId)) revert InvalidToken();
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, ERC721URIStorage) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function getSeatToken(bytes32 eventId, uint256 seatNumber)
        public view override returns (uint256)
    {
        return seatToToken[keccak256(abi.encode(eventId, seatNumber))];
    }

    /// @notice Total supply
    function totalSupply() external view returns (uint256) {
        return _tokenIdCounter;
    }
}
