# NFT Staking

A fixed-duration NFT staking contract with a per-stake ETH reward, built with
[Hardhat 3](https://hardhat.org/), [Foundry](https://book.getfoundry.sh/), and
[OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts/) 5.x.

- **Stake:** lock an NFT for 7 days, earn a fixed reward on unstake
- **Reward:** 0.001 ETH per stake, reserved from a funded pool at stake time
- **Payout:** pull-over-push — `unstake` credits a pending balance, `withdraw` pays out
- **Authorization:** only the recorded staker can unstake
- **Invariants:** ten properties specified in [`INVARIANTS.md`](./INVARIANTS.md), each with tests
- **Fuzz-tested:** two invariants (I1, I4+I10) verified across 128,000 randomized
  state transitions via Foundry stateful fuzzing
- **Live on Sepolia:** see [`DEPLOYMENTS.md`](./DEPLOYMENTS.md) for verified addresses
  and the full demo cycle

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

The invariant `address(this).balance >= rewardPool + Σ stakes[i].reward +
Σ pendingWithdrawals[a]` holds at every point. Every stake is guaranteed its
reward from the moment it exists.

### Pull-over-push payout

v1.0 pushed the reward inline during `unstake` with `call{value: reward}`. That
meant a contract staker without a `receive()` function could never unstake —
the ETH bounce reverted the whole transaction and locked the NFT.

v1.1 switches to pull-over-push:

```solidity
function unstake(uint256 tokenId) external nonReentrant {
    // ... checks ...
    delete stakes[tokenId];
    pendingWithdrawals[msg.sender] += info.reward;       // credit, don't pay
    nft.safeTransferFrom(address(this), msg.sender, tokenId);
}

function withdraw() external nonReentrant {
    uint256 amount = pendingWithdrawals[msg.sender];
    require(amount > 0, "Nothing to withdraw");
    pendingWithdrawals[msg.sender] = 0;                  // zero before call
    (bool ok, ) = payable(msg.sender).call{value: amount}("");
    require(ok, "Withdraw failed");
}
```

The contract tracks three ETH buckets at all times:

```
rewardPool               ← unreserved, available for new stakes
Σ stakes[i].reward       ← reserved, locked until unstake
Σ pendingWithdrawals[a]  ← reserved, claimable immediately
```

NFT return and reward claim are decoupled. A contract staker without
`receive()` can still unstake; it just can't withdraw until it adds one. The
NFT is never held hostage by the staker's own address type.

### CEI ordering on both external calls

Both `unstake` and `withdraw` follow checks-effects-interactions:

- `unstake`: `delete stakes[tokenId]` and the `pendingWithdrawals` credit run
  **before** `safeTransferFrom`. A malicious `onERC721Received` that re-enters
  `unstake` finds `stakes[tokenId].owner == address(0)` and reverts.
- `withdraw`: `pendingWithdrawals[msg.sender] = 0` runs **before** the ETH
  `call`. A malicious `receive()` that re-enters `withdraw` finds a zero
  balance and reverts with `"Nothing to withdraw"`.

Both surfaces are tested adversarially — see `test_ReentrancyDuringUnstakeFails`
and `test_ReentrancyDuringWithdrawFails`.

## Extensions

`Staking` composes three OpenZeppelin building blocks:

| Extension | Purpose |
| :--- | :--- |
| `IERC721Receiver` | Accepts NFT transfers from `safeTransferFrom` |
| `Ownable` | Restricts `fundRewards()` to the deployer |
| `ReentrancyGuard` | Guards `stake`, `unstake`, and `withdraw` with `nonReentrant` |

## Invariants

The contract's correctness contract lives in [`INVARIANTS.md`](./INVARIANTS.md).
Ten invariants across four categories — invariant, precondition, postcondition,
temporal — each with a positive test and an adversarial test. The build order
was driven by failure impact, not code complexity: escrow before authorization,
reentrancy defense before rewards.

| # | Invariant | Statement |
| :--- | :--- | :--- |
| I1 | Escrow consistency | Contract NFT balance = number of active stakes |
| I2 | Authorization | Only the recorded staker can unstake |
| I3 | Single unstake | A tokenId transitions Staked→Unstaked at most once |
| I4 | Reward solvency | `balance >= rewardPool + Σ stake.reward + Σ pendingWithdrawals` |
| I5 | Access control | Only the owner can `fundRewards` |
| I6 | CEI / atomicity | State updated before any external call, in `unstake` and `withdraw` |
| I7 | Duration lockup | `unstake` succeeds at `start + STAKE_DURATION`, reverts before |
| I8 | Duration immutability | `STAKE_DURATION` is `constant`, no setter |
| I9 | No owner withdrawal | No function drains `rewardPool` outside of `withdraw` |
| I10 | Pending solvency | `balance >= Σ pendingWithdrawals` across all addresses |

## Test coverage

### Deterministic tests (Hardhat)

`test/Staking.ts` — 18 tests, all passing under `npx hardhat test`:

| Test | Invariant |
| :--- | :--- |
| `test_StakeIncreasesBalance` | I1 — escrow consistency |
| `test_RevertWhen_NotApproved` | I1 — stake precondition |
| `test_RevertWhen_NonStakerUnstakes` | I2 — authorization |
| `test_RevertWhen_UnstakeBeforeDuration` | I7 — duration (below boundary) |
| `test_UnstakeAtExactDuration` | I7 — duration (at boundary) |
| `test_RevertWhen_UnstakeTwice` | I3 — single unstake |
| `test_ReentrancyDuringUnstakeFails` | I6 — NFT callback reentry blocked |
| `test_OwnerCanFundRewards` | I5 — access control (positive) |
| `test_RevertWhen_NonOwnerFundsRewards` | I5 — access control (adversarial) |
| `test_RevertWhen_StakeWithoutFunding` | I4 — solvency (adversarial) |
| `test_StakeReservesRewardFromPool` | I4 — reserve-at-stake |
| `test_UnstakeRecordsPendingWithdrawal` | I4 — reward credited on unstake |
| `test_WithdrawPaysPending` | I4 — withdraw pays exact pending |
| `test_RevertWhen_WithdrawWithoutPending` | I4 — no payout with empty balance |
| `test_ReentrancyDuringWithdrawFails` | I6 — ETH callback reentry blocked |
| `test_ContractSolvency` | I4 + I10 — balance covers all three buckets |
| `test_DurationIsImmutable` | I8 — no setter |
| `test_NoOwnerWithdraw` | I9 — no owner drain surface |

Adversarial tests use `revertedWith` / `revertedWithCustomError` to assert the
*specific* revert reason, not just that the call reverted. That way, a bug that
reverts for the wrong reason still fails the test.

### Fuzz tests (Foundry)

The 18 Hardhat tests prove the invariants hold for specific sequences. The
Foundry invariant tests prove they hold across **128,000 randomized sequences**:

| Invariant | Fuzzed test |
| :--- | :--- |
| I1 — NFT balance = active stakes | `invariant_NFTBalanceEqualsActiveStakes` |
| I4 + I10 — balance ≥ pool + Σ stakes + Σ pending | `invariant_BalanceCoversAllObligations` |

The handler (`test-foundry/handlers/StakingHandler.sol`) exposes bounded
`stake`/`unstake`/`withdraw`/`fund` actions with ghost counters that track
expected state. The invariant tests compare the contract's actual balance
against those ghost counters — so the assertion is pure arithmetic on public
getters, not a check on private state.

`test-foundry/Staking.invariant.t.sol` — 2 invariants, 256 runs × 500 calls
each = 128,000 total state transitions, all preserved.

```bash
forge test --match-contract StakingInvariantTest -vv
```

The fuzz tests were themselves validated by sabotage: removing
`rewardPool -= REWARD_AMOUNT;` from `stake` produces a counterexample on the
first randomized sequence, proving the test catches the solvency bug it's
supposed to catch.

## Usage

### Deterministic tests (Hardhat)

```bash
npx hardhat build
npx hardhat test
```

### Fuzz tests (Foundry)

```bash
forge fmt --check
forge build
forge test --match-contract StakingInvariantTest -vv
```

### Deploy locally

```bash
npx hardhat node       # start local network

# In another terminal
npx hardhat ignition deploy ignition/modules/Staking.ts \
  --network localhost \
  --parameters ignition/parameters/sepolia.json
```

### Deploy to Sepolia

See [`DEPLOYMENTS.md`](./DEPLOYMENTS.md) for the deployed addresses and the
verified demo cycle. Deployment commands:

```bash
npx hardhat ignition deploy ignition/modules/Staking.ts \
  --network sepolia \
  --parameters ignition/parameters/sepolia.json \
  --verify
```

## Tooling

Two toolchains run side by side, each doing what it does best:

| Layer | Tool | Purpose |
| :--- | :--- | :--- |
| Contracts | shared | `contracts/` (compiled by both toolchains) |
| Deterministic tests | Hardhat 3 | `test/` (`.ts` — deploy, call, assert, `evm_increaseTime`) |
| Fuzz tests | Foundry | `test-foundry/` (`.sol` — invariant handlers and assertions) |
| Deployment | Hardhat Ignition | `ignition/modules/` |
| Verification | Hardhat + Etherscan | `--verify` in deploy |
| CI | GitHub Actions | Two jobs: `hardhat` and `foundry` |

Directory boundaries:

```
contracts/          ← shared source
test/               ← Hardhat (TypeScript)
test-foundry/       ← Foundry (Solidity)
cache/              ← Hardhat build cache
cache-forge/        ← Foundry build cache
artifacts/          ← Hardhat artifacts
out/                ← Foundry artifacts
```

No directory is shared between the two build systems.

## Engineering process

This repo was built with a first-principles, spec-first discipline:

1. **Specification before code** — invariants written with failure stories and
   test names, before `Staking.sol` existed
2. **Build order by failure impact** — escrow → authorization → reentrancy →
   single-unstake → rewards → duration → structural
3. **Red → Green cycles** — every feature begins with a failing test
4. **Adversarial testing** — every invariant has a test that would catch its
   violation, not just a test that exercises the happy path
5. **Fuzz testing** — two invariants verified across 128,000 randomized
   sequences; sabotage-tested to prove the fuzzer has teeth
6. **Versioned migrations** — v1.0 (push) → v1.1 (pull-over-push) with the
   invariant set updated per version, not silently replaced

The commit history on `master` records the reasoning per cycle.

## Version history

| Tag | Change | Tests |
| :--- | :--- | :--- |
| `v1.0.0` | Push payout; documented lockup limitation for contract stakers | 14 |
| `v1.1.0` | Pull-over-push; I4 grows to three buckets, I10 added; Foundry fuzz tests | 18 + 2 fuzz |

## Known limitations

- **Fixed reward:** `REWARD_AMOUNT` is constant, not time-weighted.
- **Single stake per token:** no aggregation across multiple tokens per user.
- **No pause:** no emergency stop mechanism. Adding one would require a new
  invariant (paused state blocks `unstake` — does it block `stake` too?).
- **No reward streaming:** reward accrues once at stake time, not per block.
  A staker who stays 30 days and one who stays 7 days earn the same.
- **Pull-over-push UX cost:** unstaking and claiming are two transactions. The
  correctness gain — no NFT can be locked by the staker's own address type —
  is judged worth the extra tx.

## CI

Two jobs on every push:

- **`hardhat`** — `npm ci`, `npx hardhat build`, `npx hardhat test`
- **`foundry`** — `npm ci`, `forge build`, `forge test --match-contract StakingInvariantTest -vv`

See `.github/workflows/test.yml`.

## License

MIT
