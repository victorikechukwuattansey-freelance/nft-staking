// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Staking} from "../contracts/Staking.sol";
import {MockNFT} from "../contracts/MockNFT.sol";
import {StakingHandler} from "./handlers/StakingHandler.sol";

contract StakingInvariantTest is Test {
    Staking internal staking;
    MockNFT internal nft;
    StakingHandler internal handler;
    address internal owner;

    function setUp() public {
        owner = address(this);
        nft = new MockNFT();
        staking = new Staking(address(nft), owner);
        handler = new StakingHandler(staking, nft, owner);

        // Tell Foundry to call only the handler's functions
        targetContract(address(handler));
    }

    /// @notice I4 + I10: contract balance always covers all three buckets.
    function invariant_BalanceCoversAllObligations() public view {
        uint256 pool = staking.rewardPool();
        uint256 activeStakeRewards = handler.ghostActiveStakes() * staking.REWARD_AMOUNT();
        uint256 pending = handler.ghostPendingWithdrawals();

        uint256 owed = pool + activeStakeRewards + pending;
        uint256 held = address(staking).balance;

        assertGe(held, owed, "balance must cover pool + stakes + pending");
    }

    /// @notice I1: NFT balance always equals number of active stakes.
    function invariant_NFTBalanceEqualsActiveStakes() public view {
        uint256 nftHeld = nft.balanceOf(address(staking));
        assertEq(nftHeld, handler.ghostActiveStakes(), "NFT balance must equal active stakes");
    }
}
