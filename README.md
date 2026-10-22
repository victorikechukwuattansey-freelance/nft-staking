# NFT Staking

A fixed-duration NFT staking contract with a per-stake ETH reward, built with
[Hardhat 3](https://hardhat.org/) and
[OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts/) 5.x.

- **Stake:** lock an NFT for 7 days, earn a fixed reward on unstake
- **Reward:** 0.001 ETH per stake, reserved from a funded pool at stake time
- **Authorization:** only the recorded staker can unstake
- **Invariants:** nine properties specified in [`INVARIANTS.md`](./INVARIANTS.md), each with tests

## Design

### Reserve-at-stake, not payout-at-unstake

The naive design is to check `rewardPool >= REWARD_AMOUNT` at unstake time.
That has a griefing vector: many stakers can enter when the pool is empty,
and the first to unstake drains it, leaving the rest unable to exit.

This contract reserves the reward **at stake time**:

```solidity
function stake(uint256 tokenId) external nonReentrant {
    require(rewardPool >= REWARD_AMOUNT, "Pool underfunded");
    rewardPool -= REWARD_AMOUNT;                         // reserved
    nft.safeTransferFrom(msg.sender, address(this), tokenId);
    stakes[tokenId] = StakeInfo(msg.sender, block.timestamp, REWARD_AMOUNT);
}
```

The invariant `address(this).balance >= rewardPool + Σ stakes[i].reward` holds
at every point. Every stake is guaranteed its reward from the moment it exists.

### CEI ordering in `unstake`

All state changes happen before any external call:

```solidity
delete stakes[tokenId];                                 // state first
nft.safeTransferFrom(address(this), msg.sender, tokenId);  // then NFT
(bool ok, ) = payable(msg.sender).call{value: reward}(""); // then ETH
require(ok, "Reward transfer failed");
```

This defeats reentrancy from both `onERC721Received` (malicious NFT receiver)
and `receive()` (malicious ETH receiver). A reentrant `unstake` finds
`stakes[tokenId].owner == address(0)` and reverts with `"Not staked"`.

### Push-over-pull limitation

The reward is pushed to the staker, not recorded for later withdrawal. This
means a contract staker without a `receive()` cannot unstake — the ETH bounce
reverts the whole transaction, locking the NFT. This is documented as a known
limitation in [`INVARIANTS.md`](./INVARIANTS.md) §8 and slated for
pull-over-push in v1.1.

## Extensions

`Staking` composes three OpenZeppelin building blocks:

| Extension | Purpose |
| :--- | :--- |
| `IERC721Receiver` | Accepts NFT transfers from `safeTransferFrom` |
| `Ownable` | Restricts `fundRewards()` to the deployer |
| `ReentrancyGuard` | Guards `stake` and `unstake` with `nonReentrant` |

## Invariants

The contract's correctness contract lives in [`INVARIANTS.md`](./INVARIANTS.md).
Nine invariants across four categories — invariant, precondition, postcondition,
temporal — each with a positive test and an adversarial test. The build order
was driven by failure impact, not code complexity: escrow before authorization,
reentrancy defense before rewards.

## Test coverage

`test/Staking.ts` — 14 tests, all passing under `npx hardhat test`:

| Test | Invariant |
| :--- | :--- |
| `test_StakeIncreasesBalance` | I1 — escrow consistency |
| `test_RevertWhen_NotApproved` | I1 — stake precondition |
| `test_RevertWhen_NonStakerUnstakes` | I2 — authorization |
| `test_RevertWhen_UnstakeBeforeDuration` | I7 — duration (below boundary) |
| `test_UnstakeAtExactDuration` | I7 — duration (at boundary) |
| `test_RevertWhen_UnstakeTwice` | I3 — single unstake |
| `test_ReentrancyDuringUnstakeFails` | I6 — CEI ordering |
| `test_OwnerCanFundRewards` | I5 — access control (positive) |
| `test_RevertWhen_NonOwnerFundsRewards` | I5 — access control (adversarial) |
| `test_RevertWhen_StakeWithoutFunding` | I4 — solvency (adversarial) |
| `test_StakeReservesRewardFromPool` | I4 — reserve-at-stake |
| `test_UnstakePaysExactReward` | I4 — exact payout |
| `test_DurationIsImmutable` | I8 — no setter |
| `test_NoOwnerWithdraw` | I9 — no drain function |

Adversarial tests use `revertedWith` / `revertedWithCustomError` to assert the
*specific* revert reason, not just that the call reverted. That way, a bug that
reverts for the wrong reason still fails the test.

## Usage

```bash
npx hardhat build      # compile
npx hardhat test       # run tests
```

### Deploy locally

```bash
npx hardhat node       # start local network

# In another terminal
npx hardhat run scripts/deploy.ts --network localhost
```

## Engineering process

This repo was built with a first-principles, spec-first discipline:

1. **Specification before code** — nine invariants written down with failure
   stories and test names, before `Staking.sol` existed
2. **Build order by failure impact** — escrow → authorization → reentrancy →
   single-unstake → rewards → duration → structural
3. **Red → Green cycles** — every feature begins with a failing test
4. **Adversarial testing** — every invariant has a test that would catch its
   violation, not just a test that exercises the happy path
5. **Documented limitations** — the push-payment lockup edge case is in
   `INVARIANTS.md` §8, not swept under the rug

The commit history on `master` records the reasoning per cycle.

## Known limitations

- **Push payment:** contract stakers must implement `receive()` to claim
  rewards. Slated for pull-over-push in v1.1.
- **Fixed reward:** `REWARD_AMOUNT` is constant, not time-weighted.
- **Single stake per token:** no aggregation across multiple tokens per user.
- **No pause:** no emergency stop mechanism. Adding one would require a new
  invariant (paused state blocks `unstake` — does it block `stake` too?).

## CI

Push runs `npx hardhat build && npx hardhat test` via the Hardhat 3 default
workflow (add `.github/workflows/test.yml` to enable on GitHub).

## License

MIT
