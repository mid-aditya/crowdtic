// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CrowdTicToken
/// @notice Governance / loyalty token for the CrowdTic platform.
///         Used for: staking to earn priority queue position, governance voting,
///         loyalty rewards for frequent buyers.
contract CrowdTicToken is ERC20, Ownable, ReentrancyGuard {
    uint256 public constant MAX_SUPPLY = 100_000_000 * 10**18; // 100M tokens

    mapping(address => uint256) public stakedAmount;
    mapping(address => uint256) public stakeTimestamp;

    uint256 public constant STAKE_LOCK_SECONDS = 30 days;
    uint256 public constant REWARDS_PER_STAKED_PER_SECOND = 1157407407407407; // ~1% APY in wei terms per token staked

    uint256 public totalStaked;

    // ── Events ─────────────────────────────────────────────────────────────
    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount, uint256 reward);
    event TokensClaimed(address indexed user, uint256 amount);

    // ── Init ───────────────────────────────────────────────────────────────
    constructor() ERC20("CrowdTic Token", "CTOK") Ownable(msg.sender) {
        // Pre-mint for team/treasury (5% of max supply)
        _mint(msg.sender, MAX_SUPPLY * 5 / 100);
    }

    // ── Staking ────────────────────────────────────────────────────────────
    /// @notice Stake CTK tokens to gain priority in the waiting room queue.
    ///         More stake = higher priority score in the fair queue algorithm.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert();
        if (totalSupply() + totalStaked + amount > MAX_SUPPLY) revert();

        _claimReward(msg.sender);

        _transfer(msg.sender, address(this), amount);
        stakedAmount[msg.sender] += amount;
        stakeTimestamp[msg.sender] = block.timestamp;
        totalStaked += amount;

        emit Staked(msg.sender, amount);
    }

    /// @notice Unstake CTK tokens after lock period. Accrues staking reward.
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert();
        if (stakedAmount[msg.sender] < amount) revert();

        // Check lock period
        if (block.timestamp < stakeTimestamp[msg.sender] + STAKE_LOCK_SECONDS) revert();

        _claimReward(msg.sender);

        stakedAmount[msg.sender] -= amount;
        totalStaked -= amount;

        _transfer(address(this), msg.sender, amount);
        emit Unstaked(msg.sender, amount, 0);
    }

    // ── Rewards ────────────────────────────────────────────────────────────
    function getPendingReward(address user) public view returns (uint256) {
        uint256 staked = stakedAmount[user];
        if (staked == 0) return 0;
        uint256 elapsed = block.timestamp - stakeTimestamp[user];
        return staked * elapsed * REWARDS_PER_STAKED_PER_SECOND / 1e18;
    }

    function _claimReward(address user) internal {
        uint256 reward = getPendingReward(user);
        if (reward > 0) {
            stakeTimestamp[user] = block.timestamp;
            _mint(user, reward);
            emit TokensClaimed(user, reward);
        }
    }

    function claimReward() external nonReentrant {
        _claimReward(msg.sender);
    }

    // ── Airdrop ────────────────────────────────────────────────────────────
    /// @notice Airdrop tokens to a list of addresses (organizer promotion campaign)
    function airdrop(address[] calldata recipients, uint256[] calldata amounts)
        external onlyOwner nonReentrant
    {
        if (recipients.length != amounts.length) revert();
        uint256 total;
        for (uint256 i = 0; i < recipients.length; i++) {
            _mint(recipients[i], amounts[i]);
            total += amounts[i];
        }
        if (totalSupply() > MAX_SUPPLY) revert("Exceeds max supply");
    }
}
