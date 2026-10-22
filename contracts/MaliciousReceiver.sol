// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface IStaking {
    function stake(uint256 tokenId) external;
    function unstake(uint256 tokenId) external;
}

/// @notice Adversarial staker. On receiving its NFT back from unstake,
///         attempts to re-enter unstake for the same tokenId.
contract MaliciousReceiver is IERC721Receiver {
    IStaking public immutable staking;
    IERC721 public immutable nft;

    bool public reentered;
    bool public reentrySucceeded;
    bytes public reentryError;

    constructor(address _staking, address _nft) {
        staking = IStaking(_staking);
        nft = IERC721(_nft);
    }

    function approveAndStake(uint256 tokenId) external {
        nft.approve(address(staking), tokenId);
        staking.stake(tokenId);
    }

    function doUnstake(uint256 tokenId) external {
        staking.unstake(tokenId);
    }

    function onERC721Received(
        address,
        address,
        uint256 tokenId,
        bytes calldata
    ) external override returns (bytes4) {
        if (!reentered) {
            reentered = true;
            try staking.unstake(tokenId) {
                reentrySucceeded = true;
            } catch (bytes memory err) {
                reentryError = err;
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    // @notice Required to accept ETH reward from unstake. Also the secondary
    ///         reentry surface — if the contract had reentrancy risk in the
    ///         ETH payout, this is where it would fire.
    receive() external payable {}
}
