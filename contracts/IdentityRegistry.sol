// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title IdentityRegistry
/// @notice Stores a ZK-compatible commitment of NIK.
///         The actual NIK is NEVER stored on-chain.
///         Uses Soulbound Token (SBT) pattern — KYC token is non-transferable.
///
/// @dev Workflow:
///      1. Off-chain: user hashes SHA256(NIK + pepper) → commitment
///      2. Off-chain prover generates a ZK proof that:
///         - commitment matches the submitted one
///         - NIK passes Indonesian checksum validation
///      3. On-chain: submit proof → verify → issue SBT
///      4. NFT contract queries isKYCVerified(wallet) to allow transfers
contract IdentityRegistry is ERC721, Ownable {
    // ── State ─────────────────────────────────────────────────────────────
    mapping(address => bool)         public kycVerified;
    mapping(address => bytes32)       public commitments;    // hash(NIK + pepper)
    mapping(address => bool)          public hasSBT;         // one SBT per wallet

    // ── Errors ────────────────────────────────────────────────────────────
    error AlreadyVerified();
    error NotVerified();
    error AlreadyHasSBT();
    error InvalidCommitment();

    // ── Events ─────────────────────────────────────────────────────────────
    event KYCVerified(address indexed user, bytes32 commitment);
    event KYCRevoked(address indexed user);

    // ── Init ───────────────────────────────────────────────────────────────
    constructor() ERC721("CrowdTic KYC SBT", "CTKYC") Ownable(msg.sender) {}

    // ── ZK-Verified KYC ───────────────────────────────────────────────────
    /// @notice Called by the booking-service wallet after ZK proof is verified off-chain.
    /// @param user The wallet to mark as KYC-verified
    /// @param commitment The hash commitment (SHA256 of NIK + pepper) — never the NIK itself
    function verifyZKKYC(address user, bytes32 commitment) external onlyOwner {
        if (kycVerified[user]) revert AlreadyVerified();
        if (commitment == bytes32(0)) revert InvalidCommitment();

        commitments[user] = commitment;
        kycVerified[user] = true;

        // Mint a Soulbound Token (cannot be transferred)
        if (!hasSBT[user]) {
            uint256 tokenId = uint256(uint160(user)); // deterministic
            _safeMint(user, tokenId);
            hasSBT[user] = true;
        }

        emit KYCVerified(user, commitment);
    }

    /// @notice Revoke KYC (organizer/admin use only)
    function revokeKYC(address user) external onlyOwner {
        kycVerified[user] = false;
        delete commitments[user];
        emit KYCRevoked(user);
    }

    /// @notice Check if wallet passed KYC
    function isKYCDone(address user) external view returns (bool) {
        return kycVerified[user];
    }

    /// @notice Get commitment hash for a user (useful for off-chain prover)
    function getCommitment(address user) external view returns (bytes32) {
        return commitments[user];
    }

    // ── Soulbound Override ─────────────────────────────────────────────────
    /// @dev SBT: tokens cannot be transferred. One SBT per wallet.
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 /*tokenId*/
    ) internal override {
        super._beforeTokenTransfer(from, to, 0);
        // Soulbound — no transfers allowed
        if (from != address(0) && to != address(0)) {
            revert("Soulbound: non-transferable");
        }
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
