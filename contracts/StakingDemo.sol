// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Identical logic to `Staking`, but with a 60-second duration so the
///      full stake/unstake/withdraw cycle can be exercised on a live network
///      without waiting 7 days. NOT for production — production is `Staking`.
contract StakingDemo is IERC721Receiver, ReentrancyGuard, Ownable {
    struct StakeInfo {
        address owner;
        uint256 start;
        uint256 reward;
    }

    IERC721 public immutable nft;
    uint256 public constant STAKE_DURATION = 60 seconds;
    uint256 public constant REWARD_AMOUNT = 0.001 ether;

    uint256 public rewardPool;
    mapping(uint256 tokenId => StakeInfo) public stakes;
    mapping(address => uint256) public pendingWithdrawals;

    event Staked(uint256 indexed tokenId, address indexed owner, uint256 reward);
    event Unstaked(uint256 indexed tokenId, address indexed owner, uint256 reward);
    event Withdrawn(address indexed staker, uint256 amount);
    event Funded(address indexed funder, uint256 amount);

    constructor(address _nft, address _initialOwner) Ownable(_initialOwner) {
        nft = IERC721(_nft);
    }

    function stake(uint256 tokenId) external nonReentrant {
        require(rewardPool >= REWARD_AMOUNT, "Pool underfunded");
        rewardPool -= REWARD_AMOUNT;
        nft.safeTransferFrom(msg.sender, address(this), tokenId);
        stakes[tokenId] = StakeInfo(msg.sender, block.timestamp, REWARD_AMOUNT);
        emit Staked(tokenId, msg.sender, REWARD_AMOUNT);
    }

    function unstake(uint256 tokenId) external nonReentrant {
        StakeInfo memory info = stakes[tokenId];
        require(info.owner != address(0), "Not staked");
        require(info.owner == msg.sender, "Not staker");
        require(block.timestamp >= info.start + STAKE_DURATION, "Too early");

        delete stakes[tokenId];
        pendingWithdrawals[msg.sender] += info.reward;
        nft.safeTransferFrom(address(this), msg.sender, tokenId);

        emit Unstaked(tokenId, msg.sender, info.reward);
    }

    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "Withdraw failed");
        emit Withdrawn(msg.sender, amount);
    }

    function fundRewards() external payable onlyOwner {
        require(msg.value > 0, "Zero amount");
        rewardPool += msg.value;
        emit Funded(msg.sender, msg.value);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
