// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice NFT staking — I1 (escrow) only. Unstake, rewards, access control,
///         and reentrancy guards are added with their own invariants (I2–I9).


contract Staking is IERC721Receiver {
    struct StakeInfo {
        address owner;
        uint256 start;
    }

    IERC721 public immutable nft;
    uint256 public constant STAKE_DURATION = 7 days;

    mapping(uint256 tokenId => StakeInfo) public stakes;

    constructor(address _nft) {
        nft = IERC721(_nft);
    }

    /// @notice Escrow an NFT into the contract. The caller must own `tokenId`
    ///         and have approved this contract for it.


    function stake(uint256 tokenId) external {
        nft.safeTransferFrom(msg.sender, address(this), tokenId);
        stakes[tokenId] = StakeInfo({
            owner: msg.sender,
            start: block.timestamp
        });
    }

    


    /// @notice Return the staked NFT to the recorded staker, after lockup.
    /// @dev I2: only the recorded staker can call this.
    ///      I7: reverts if lockup has not elapsed.


    function unstake(uint256 tokenId) external {
        StakeInfo memory info = stakes[tokenId];
    
        require(info.owner != address(0), "Not staked");   // I3 precondition
        require(info.owner == msg.sender, "Not staker");   // I2
        require(
            block.timestamp >= info.start + STAKE_DURATION,
            "Too early"
        );                                                  // I7
    
        // CEI: state changes before external call
        delete stakes[tokenId];
    
        nft.safeTransferFrom(address(this), msg.sender, tokenId);
    }

    /// @dev Required for `safeTransferFrom` to accept the NFT. Without this,
    ///      `stake` reverts — IERC721Receiver's `onERC721Received` must return
    ///      its own selector.

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
