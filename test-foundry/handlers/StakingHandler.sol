// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Staking} from "../../contracts/Staking.sol";
import {MockNFT} from "../../contracts/MockNFT.sol";

/// @notice Wrapper that exposes bounded, safe actions for the fuzzer.
///         The fuzzer calls `stake`, `unstake`, `withdraw` in random order
///         and with random arguments (bounded by `bound`).
contract StakingHandler is Test {
    Staking public immutable staking;
    MockNFT public immutable nft;
    address public immutable funder;

    // Bounded actor pool — the fuzzer picks from these
    address[] public actors;

    // Per-actor token IDs that could be staked (each actor gets a fixed set)
    mapping(address => uint256[]) public tokensForActor;

    // Ghost counters: sums we expect the contract to hold
    uint256 public ghostActiveStakes;
    uint256 public ghostPendingWithdrawals;

    constructor(Staking _staking, MockNFT _nft, address _funder) {
        staking = _staking;
        nft = _nft;
        funder = _funder;

        // Pre-mint a bounded set of NFTs to bounded actors
        for (uint256 i = 0; i < 3; i++) {
            address actor = address(uint160(0x1000 + i));
            actors.push(actor);
            for (uint256 j = 0; j < 5; j++) {
                uint256 tokenId = nft.mint(actor);
                tokensForActor[actor].push(tokenId);
            }
        }

        // Fund the pool generously so `stake` never reverts on funding
        vm.deal(funder, 100 ether);
        vm.prank(funder);
        staking.fundRewards{value: 10 ether}();
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function tokenCount(address actor) external view returns (uint256) {
        return tokensForActor[actor].length;
    }

    /// @notice Fuzz target: stake a random token from a random actor.
    function stake(uint256 actorSeed, uint256 tokenSeed) external {
        address actor = actors[actorSeed % actors.length];
        uint256[] memory tokens = tokensForActor[actor];
        uint256 tokenId = tokens[tokenSeed % tokens.length];

        // Skip if token is already staked or not owned by actor
        if (nft.ownerOf(tokenId) != actor) return;

        vm.prank(actor);
        nft.approve(address(staking), tokenId);

        vm.prank(actor);
        try staking.stake(tokenId) {
            ghostActiveStakes += 1;
        } catch {}
    }

    /// @notice Fuzz target: warp time and unstake a random token from a random actor.
    function unstake(uint256 actorSeed, uint256 tokenSeed, uint256 warp) external {
        address actor = actors[actorSeed % actors.length];
        uint256[] memory tokens = tokensForActor[actor];
        uint256 tokenId = tokens[tokenSeed % tokens.length];

        (address stakeOwner,,) = staking.stakes(tokenId);
        if (stakeOwner != actor) return;

        // Warp past the lockup so `unstake` can succeed
        vm.warp(block.timestamp + staking.STAKE_DURATION() + (warp % 1 days));

        vm.prank(actor);
        try staking.unstake(tokenId) {
            ghostActiveStakes -= 1;
            ghostPendingWithdrawals += staking.REWARD_AMOUNT();
        } catch {}
    }

    /// @notice Fuzz target: withdraw from a random actor.
    function withdraw(uint256 actorSeed) external {
        address actor = actors[actorSeed % actors.length];
        uint256 pending = staking.pendingWithdrawals(actor);
        if (pending == 0) return;

        vm.prank(actor);
        try staking.withdraw() {
            ghostPendingWithdrawals -= pending;
        } catch {}
    }

    /// @notice Fuzz target: fund the pool (owner only — handler is owner via setUp).
    function fund(uint256 amount) external {
        uint256 bounded = bound(amount, 0.001 ether, 1 ether);
        vm.deal(funder, funder.balance + bounded);
        vm.prank(funder);
        staking.fundRewards{value: bounded}();
    }
}
