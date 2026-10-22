// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface IStaking {
    function stake(uint256 tokenId) external;
    function unstake(uint256 tokenId) external;
    function withdraw() external;
}

contract MaliciousReceiver is IERC721Receiver {
    IStaking public immutable staking;
    IERC721 public immutable nft;

    // NFT callback reentry — fires during unstake's safeTransferFrom
    bool public unstakeReentered;
    bool public unstakeReentrySucceeded;
    bytes public unstakeReentryError;

    // ETH callback reentry — fires during withdraw's call{value}
    bool public withdrawReentered;
    bool public withdrawReentrySucceeded;
    bytes public withdrawReentryError;

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

    function doWithdraw() external {
        staking.withdraw();
    }

    function onERC721Received(
        address, address, uint256 tokenId, bytes calldata
    ) external override returns (bytes4) {
        if (!unstakeReentered) {
            unstakeReentered = true;
            try staking.unstake(tokenId) {
                unstakeReentrySucceeded = true;
            } catch (bytes memory err) {
                unstakeReentryError = err;
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {
        if (!withdrawReentered) {
            withdrawReentered = true;
            try staking.withdraw() {
                withdrawReentrySucceeded = true;
            } catch (bytes memory err) {
                withdrawReentryError = err;
            }
        }
    }
}
