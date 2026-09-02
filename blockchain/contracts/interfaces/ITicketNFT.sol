// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ITicketNFT
/// @notice Interface for NFT-based event tickets
interface ITicketNFT {
    struct Ticket {
        bytes32 eventId;
        uint256 seatNumber;
        uint256 faceValue;      // in wei
        uint256 maxResalePrice;  // e.g. 120% of faceValue
        bool    kycRequired;
        address originalOwner;
        bool    transferred;
        string  metadataURI;     // IPFS CID
    }

    /// @notice Mint a ticket NFT after off-chain commit succeeds
    /// @param to The ticket owner's wallet address
    /// @param eventId Unique event identifier (bytes32 for cross-chain compatibility)
    /// @param seatNumber Seat number within the event
    /// @param faceValue Face value in wei
    /// @param kycRequired Whether this ticket requires KYC for transfer
    /// @param metadataURI IPFS CID pointing to off-chain metadata
    /// @return tokenId The minted token ID
    function mintTicket(
        address to,
        bytes32 eventId,
        uint256 seatNumber,
        uint256 faceValue,
        bool    kycRequired,
        string calldata metadataURI
    ) external returns (uint256 tokenId);

    /// @notice Cancel/refund a ticket — burns the NFT
    /// @param tokenId The ticket to cancel
    function cancelTicket(uint256 tokenId) external;

    /// @notice Check if a seat is already minted for an event
    /// @param eventId The event
    /// @param seatNumber The seat number
    /// @return tokenId or 0 if not minted
    function getSeatToken(bytes32 eventId, uint256 seatNumber) external view returns (uint256);

    /// @notice Verify KYC status of an address
    /// @param user Wallet address to check
    /// @return true if KYC verified
    function isKYCVerified(address user) external view returns (bool);
}
