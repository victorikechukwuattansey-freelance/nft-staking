# Staking Contract — Invariant Specification

**Version:** 1.0
**Scope:** NFT staking with fixed-duration lockup and single-shot reward payout
**Status:** Specification — no implementation yet. `Staking.sol` must satisfy every property below.

This document is the contract's correctness contract. It was derived *before*
the code, from first principles: enumerate the assets, the actors, the state,
and the transitions — then ask "what must never be true?" of each. Every
invariant maps to at least one test in `test/Staking.ts`. If a test cannot be
written for an invariant, the invariant is not a real invariant — it's a hope.

---

## 1. Scope

**In scope (v1):**
- One NFT collection, one staking contract
- One stake per tokenId at a time
- Fixed global `STAKE_DURATION` (immutable)
- A single reward amount per stake, paid on unstake
- Owner-funded reward pool
- Pause not included in v1

**Explicitly out of scope (v1):**
- Reward streaming / per-block accrual
- Multiple stakes per user with per-user accounting
- NFT boosts, tiered rewards, multiplier weights
- Upgradeability
- ERC-20 reward tokens (ETH only in v1)

Out-of-scope items become **future invariants** in their own `INVARIANTS.md`
version. They must not be added without re-deriving the spec — because each one
can invalidate an invariant below.

---

## 2. Structure

### 2.1 Assets the contract holds

| Asset | Owner of record | Contract's claim about it |
| :--- | :--- | :--- |
| NFTs (ERC-721) | Depositing staker | "I hold this token because `stakes[tokenId].owner` deposited it" |
| ETH (reward pool) | Owner (funder) | "I hold this ETH to pay out rewards on unstake" |
| Stake records (`stakes` mapping) | — | "This is the truth about who staked what and when" |

### 2.2 Actors

| Actor | Can do | Cannot do |
| :--- | :--- | :--- |
| **Owner** | Fund rewards, (future) set duration, (future) pause | Unstake on behalf of a staker, mint NFTs |
| **Staker** | Stake their own NFT, unstake after duration, claim reward | Unstake someone else's NFT, unstake before duration |
| **Anyone** | Read state, call view functions | Mutate state without becoming a staker or owner |

### 2.3 State variables

| Variable | Type | Claim about the world |
| :--- | :--- | :--- |
| `nft` | `IERC721 immutable` | "This is the collection I accept" |
| `STAKE_DURATION` | `uint256 immutable` | "Every stake must last at least this long" |
| `stakes[tokenId].owner` | `address` | "This address deposited tokenId; only they may unstake" |
| `stakes[tokenId].start` | `uint256` | "Staking began at this block timestamp" |
| `stakes[tokenId].reward` | `uint256` | "This many wei are owed to `owner` on unstake" |
| `rewardPool` | `uint256` | "This much ETH is reserved for unclaimed rewards" |

### 2.4 State machine (per tokenId)

```
        stake(tokenId)
Unstaked ─────────────▶ Staked ─────────────▶ Unstaked
   ▲                      │
   │                      │  unstake(tokenId)
   │  (after duration)    │  (before duration)
   │                      ▼
   └────── Staked ──── revert("Too early")
```

- **Unstaked → Staked:** `stake(tokenId)` — requires the caller owns the NFT and has approved the staking contract. The NFT moves into the contract; `stakes[tokenId]` is written.
- **Staked → Unstaked:** `unstake(tokenId)` — requires the caller is the recorded staker, the duration has elapsed, and the reward is available. The NFT moves out; `stakes[tokenId]` is deleted; reward is paid.
- **Staked → Staked (revert):** `unstake(tokenId)` before duration elapses — reverts, no state change.

### 2.5 Transitions

| Function | Reads | Writes | External call |
| :--- | :--- | :--- | :--- |
| `stake(tokenId)` | `msg.sender`, `tokenId` | `stakes[tokenId]` | `nft.safeTransferFrom(msg.sender, this, tokenId)` |
| `unstake(tokenId)` | `stakes[tokenId]`, `block.timestamp` | `stakes[tokenId]` (delete), `rewardPool` (decrement) | `nft.safeTransferFrom(this, msg.sender, tokenId)`; ETH transfer |
| `fundRewards()` | `msg.sender`, `msg.value` | `rewardPool` (increment) | — |
| `onERC721Received` | — | — | — |

---

## 3. Invariants

Each entry has: **Category** (invariant / precondition / postcondition / temporal),
**Statement** (one declarative sentence), **Failure story** (what breaks if it's
violated), **Test name** (the Foundry/Hardhat test that asserts it), and **Type**
(positive, adversarial, or fuzz).

### I1 — Escrow consistency

- **Category:** invariant
- **Statement:** The contract's NFT balance always equals the number of entries in `stakes` with a nonzero `owner`.
- **Failure story:** If `nft.balanceOf(staking) > activeStakes`, the contract holds NFTs nobody can claim — permanent lockup. If `<`, a staker's unstake will revert — the contract is insolvent in NFTs.
- **Test name:** `testFuzz_BalanceEqualsActiveStakes`
- **Type:** fuzz — random sequences of stake/unstake; after each, assert the equality.

### I2 — Authorization (only staker may unstake)

- **Category:** precondition of `unstake`
- **Statement:** Only the address recorded in `stakes[tokenId].owner` at the time of the call can successfully call `unstake(tokenId)`.
- **Failure story:** Anyone could steal any staked NFT by calling `unstake` on a token they don't own. Total loss of user funds. This is the single most damaging bug class in staking contracts.
- **Test name:** `test_RevertWhen_NonStakerUnstakes`
- **Type:** adversarial — `expectRevert` when a non-staker calls `unstake`.

### I3 — Single unstake (no double release)

- **Category:** invariant
- **Statement:** A given `tokenId` transitions from Staked back to Unstaked at most once. After `unstake(tokenId)` succeeds, `stakes[tokenId].owner == address(0)`.
- **Failure story:** Without deletion, a second `unstake` on the same tokenId would revert only if the NFT is gone — but if the contract holds other NFTs, the second call could release a *different* token's NFT, effectively stealing from another staker.
- **Test name:** `test_RevertWhen_UnstakeTwice`
- **Type:** adversarial — stake, warp full duration, unstake (success), unstake again → expect revert.

### I4 — Reward solvency

- **Category:** invariant
- **Statement:** At all times, `rewardPool >= Σ stakes[tokenId].reward` over all staked tokens. Equivalently: cumulative rewards paid out never exceed the ETH deposited via `fundRewards()`.
- **Failure story:** Insolvency. If the pool runs out before all stakers are paid, the last to unstake get nothing. Worse: the contract's ETH balance could be drained by an earlier staker if reward math is wrong.
- **Test name:** `testFuzz_PoolDecrementsByExactlyPaid`
- **Type:** fuzz — random `fundRewards` amounts and reward values; assert `pool_after == pool_before - paid` on each unstake, and `pool >= 0` always.

### I5 — Access control (owner-only mutation of pool)

- **Category:** precondition of `fundRewards`, and (future) `setDuration` / `pause`
- **Statement:** Only the contract's `owner()` can call `fundRewards()`. No other address can increase `rewardPool` or modify `STAKE_DURATION`.
- **Failure story:** A non-owner could manipulate `rewardPool` arithmetic to enable insolvency (e.g., by calling `fundRewards` with a phantom balance), or lock stakers out of unstaking. Access control is the boundary between "trusted admin actions" and "user actions".
- **Test name:** `test_RevertWhen_NonOwnerFundsRewards` (and future: `NonOwnerSetsDuration`, `NonOwnerPauses`)
- **Type:** adversarial — `expectRevert` for each non-owner caller.

### I6 — Atomicity and CEI ordering

- **Category:** invariant
- **Statement:** If `unstake` reverts for any reason, no state changes persist. During a successful `unstake`, `delete stakes[tokenId]` and the `rewardPool` decrement execute **before** any external call (NFT transfer or ETH transfer).
- **Failure story:** Classic reentrancy. If the NFT transfer or ETH transfer happens before state deletion, a malicious `onERC721Received` (or ETH fallback) callback could re-enter `unstake` and:
  - (NFT case) unstake the same tokenId twice before deletion → contract releases a token it doesn't have, or releases another staker's token;
  - (ETH case) claim the reward twice → pool drained.
- **Test name:** `test_RevertWhen_MaliciousReceiverReenters`
- **Type:** adversarial — a malicious ERC-721 receiver that re-enters `unstake` from `onERC721Received`; expect the outer call to revert and no state to change.

### I7 — Duration lockup

- **Category:** temporal property
- **Statement:** `unstake(tokenId)` reverts if `block.timestamp < stakes[tokenId].start + STAKE_DURATION`. It succeeds at or after that boundary.
- **Failure story:** Reward accrual assumes a minimum holding period. Early unstake = free rewards = pool drain. Even if rewards aren't time-weighted in v1, the lockup is a design contract: stakers commit their NFTs for a period.
- **Test name:** `test_RevertWhen_UnstakeBeforeDuration` and `test_UnstakeAtExactDuration`
- **Type:** temporal — Hardhat: `time.increase(STAKE_DURATION - 1)` → expect revert; `time.increase(1)` more → expect success. Tests **both sides of the boundary**, since off-by-one errors are common in duration math.

### I8 — Duration immutability

- **Category:** invariant (v1 — because `STAKE_DURATION` is `immutable`)
- **Statement:** `STAKE_DURATION` cannot change after deployment. (If a future version makes duration mutable, this becomes a temporal property: "changing duration never affects existing stakes.")
- **Failure story:** If duration could be shortened post-stake, the owner could let stakers exit early and drain rewards. If lengthened, stakers could be locked longer than agreed.
- **Test name:** `test_DurationIsImmutable`
- **Type:** structural — assert `Staking.STAKE_DURATION()` returns a constant and no setter exists. (This is enforced by the compiler via `immutable`, so the test is a documentation guard.)

### I9 — Fund returns only via unstake

- **Category:** postcondition of `fundRewards`, precondition of any withdrawal
- **Statement:** ETH deposited via `fundRewards()` can only leave the contract as a reward payout triggered by a successful `unstake(tokenId)`. No function lets the owner withdraw unclaimed rewards (v1).
- **Failure story:** If the owner can withdraw from `rewardPool` after stakers are committed, the pool can be drained while stakers are locked, making the contract insolvent when they unstake.
- **Test name:** `test_RevertWhen_OwnerWithdrawsDirectly` — expects that no such function exists, or that calling any direct-withdraw function reverts.
- **Type:** adversarial — check that the ABI surface contains no `withdraw` on the owner's side, or that any such function fails.

---

## 4. Positive / adversarial test matrix

Every invariant gets both a **positive** test (proves the path works) and an **adversarial** test (proves the guard holds). Missing either half is a gap.

| # | Invariant | Positive test | Adversarial test |
| :--- | :--- | :--- | :--- |
| I1 | Escrow consistency | `test_StakeIncreasesBalance` | `testFuzz_BalanceEqualsActiveStakes` |
| I2 | Only staker unstakes | `test_StakerCanUnstake` | `test_RevertWhen_NonStakerUnstakes` |
| I3 | Single unstake | `test_UnstakeClearsState` | `test_RevertWhen_UnstakeTwice` |
| I4 | Pool solvency | `test_UnstakePaysExactReward` | `testFuzz_PoolDecrementsByExactlyPaid` |
| I5 | Access control | `test_OwnerCanFund` | `test_RevertWhen_NonOwnerFundsRewards` |
| I6 | CEI / atomicity | `test_UnstakeOrdering` | `test_RevertWhen_MaliciousReceiverReenters` |
| I7 | Duration lockup | `test_UnstakeAtExactDuration` | `test_RevertWhen_UnstakeBeforeDuration` |
| I8 | Immutability | `test_DurationIsImmutable` | (compiler-enforced) |
| I9 | No direct withdraw | (no positive — absence) | `test_RevertWhen_OwnerWithdrawsDirectly` |

---

## 5. Test-first build order

The order matters. It's driven by **failure impact**, not by code complexity.

1. **I1 (escrow)** — a bug here locks user NFTs. Build `stake` + `onERC721Received` + the fuzz invariant first.
2. **I2 (authorization)** — a bug here loses user NFTs. Add the `owner == msg.sender` check and its adversarial test.
3. **I6 (CEI)** — a bug here enables reentrancy against both NFTs and ETH. Add `nonReentrant` and the malicious-receiver test. Do this **before** adding rewards, because the ETH payout path is where reentrancy becomes economically profitable.
4. **I3 (single unstake)** — a bug here compounds I2/I6. Verify deletion before the transfer.
5. **I4 + I5 (solvency + access)** — add `fundRewards`, then `unstake`'s reward payout, then the fuzz tests that prove neither overspends nor underfunds.
6. **I7 (duration)** — cheap to add; test the boundary on both sides.
7. **I8, I9 (immutability, no withdraw)** — documentation-style tests that lock in the current scope.

If any of steps 1–3 slip, stop. Do not proceed to rewards. Rewards on top of an insecure escrow is a contract that pays attackers.

---

## 6. What this document is not

- **Not a substitute for audits.** Invariants catch classes of bugs; they don't prove absence of all bugs. Only an audit and possibly formal verification do that.
- **Not a design decision record.** It says *what must be true*, not *why* a particular design (ETH-only, immutable duration, single reward) was chosen. That belongs in the README.
- **Not static.** If the contract grows features, invariants get added, not reordered. Each addition re-validates the existing set against the new behavior.

---

## 7. Change log

| Date | Change | Reason |
| :--- | :--- | :--- |
| 2026-10-21 | Initial spec — 9 invariants, 3 out-of-scope extensions | v1 design freeze before implementation |
