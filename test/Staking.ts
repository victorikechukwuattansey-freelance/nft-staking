import { expect } from "chai";
import { network } from "hardhat";

// const { ethers } = await network.create();

describe("Staking — full lifecycle (I1–I7)", function () {
  async function deployFixture(opts: { funded?: boolean } = {}) {
    const funded = opts.funded ?? true;
    const { ethers, networkHelpers } = await network.create(); // or network.create()
    const [owner, victor, iyke] = await ethers.getSigners();

    const nft = await ethers.deployContract("MockNFT");
    await nft.waitForDeployment();

    // Mint token 0 to victor
    await nft.mint(victor.address);

    const staking = await ethers.deployContract("Staking", [
      await nft.getAddress(),
      owner.address,
    ]);
    await staking.waitForDeployment();

    if (funded) {
      // Fund enough for many tests' worth of stakes; each stake reserves 0.001 ETH
      await staking
        .connect(owner)
        .fundRewards({ value: ethers.parseEther("1") });
    }

    return { ethers, networkHelpers, nft, staking, owner, victor, iyke };
  }

  it("test_StakeIncreasesBalance — contract holds NFT after stake", async function () {
    const { nft, staking, victor } = await deployFixture();
    const stakingAddr = await staking.getAddress();

    // Victor approves the staking contract to move token 0
    await nft.connect(victor).approve(stakingAddr, 0);

    // Victor stakes token 0
    await staking.connect(victor).stake(0);

    // I1: the contract's NFT balance equals the number of active stakes
    expect(await nft.ownerOf(0)).to.equal(stakingAddr);
    expect(await nft.balanceOf(stakingAddr)).to.equal(1);
  });

  it("test_RevertWhen_NotApproved — stake fails without approval", async function () {
    const { nft, staking, victor } = await deployFixture();
    const stakingAddr = await staking.getAddress();

    // Victor has NOT approved the staking contract to move token 0.
    // safeTransferFrom inside stake reverts with the ERC-721 authorization error.
    await expect(
      staking.connect(victor).stake(0),
    ).to.be.revertedWithCustomError(nft, "ERC721InsufficientApproval");

    // I1: contract balance stays 0
    expect(await nft.balanceOf(stakingAddr)).to.equal(0);
  });

  it("test_RevertWhen_NonStakerUnstakes — non-staker cannot unstake", async function () {
    const { ethers, networkHelpers, nft, staking, victor, iyke } =
      await deployFixture();
    const stakingAddr = await staking.getAddress();

    // Victor stakes token 0
    await nft.connect(victor).approve(stakingAddr, 0);
    await staking.connect(victor).stake(0);

    // Warp past the lockup duration (I7), so this test isolates I2 (auth).
    // time.increase() also mines a block — no separate evm_mine call needed.
    await networkHelpers.time.increase(7 * 24 * 60 * 60);
    // Iyke tries to unstake Victor's token
    await expect(staking.connect(iyke).unstake(0)).to.revert(
      ethers,
      "Not staker",
    );
  });

  // ─── I7: Duration lockup ─────────────────────────────────────────────

  it("test_RevertWhen_UnstakeBeforeDuration — cannot unstake early", async function () {
    const { nft, staking, networkHelpers, victor } = await deployFixture();
    const stakingAddr = await staking.getAddress();

    await nft.connect(victor).approve(stakingAddr, 0);
    await staking.connect(victor).stake(0);

    const stakeTime = await networkHelpers.time.latest();
    // Unstake's block will execute at exactly stakeTime + (duration - 1)
    await networkHelpers.time.setNextBlockTimestamp(
      stakeTime + 7 * 24 * 60 * 60 - 1,
    );

    await expect(staking.connect(victor).unstake(0)).to.be.revertedWith(
      "Too early",
    );
  });

  it("test_UnstakeAtExactDuration — succeeds at the boundary", async function () {
    const { nft, staking, networkHelpers, victor } = await deployFixture();
    const stakingAddr = await staking.getAddress();

    await nft.connect(victor).approve(stakingAddr, 0);
    await staking.connect(victor).stake(0);

    const stakeTime = await networkHelpers.time.latest();
    // Unstake's block will execute at exactly stakeTime + duration
    await networkHelpers.time.setNextBlockTimestamp(
      stakeTime + 7 * 24 * 60 * 60,
    );

    await staking.connect(victor).unstake(0);
    expect(await nft.ownerOf(0)).to.equal(victor.address);
  });

  // ─── I3: Single unstake ──────────────────────────────────────────────

  it("test_RevertWhen_UnstakeTwice — cannot unstake same token twice", async function () {
    const { nft, staking, networkHelpers, victor } = await deployFixture();
    const stakingAddr = await staking.getAddress();

    await nft.connect(victor).approve(stakingAddr, 0);
    await staking.connect(victor).stake(0);

    await networkHelpers.time.increase(7 * 24 * 60 * 60);

    // First unstake succeeds
    await staking.connect(victor).unstake(0);
    expect(await nft.ownerOf(0)).to.equal(victor.address);

    // Second unstake reverts — `delete stakes[tokenId]` cleared the state
    await expect(staking.connect(victor).unstake(0)).to.be.revertedWith(
      "Not staked",
    );
  });

  it("test_ReentrancyDuringUnstakeFails — NFT callback reentry blocked", async function () {
    const { ethers, networkHelpers, nft, staking, victor } =
      await deployFixture();
    const stakingAddr = await staking.getAddress();
    const nftAddr = await nft.getAddress();

    const Malicious = await ethers.deployContract("MaliciousReceiver", [
      stakingAddr,
      nftAddr,
    ]);
    await Malicious.waitForDeployment();
    const maliciousAddr = await Malicious.getAddress();

    await nft.connect(victor).transferFrom(victor.address, maliciousAddr, 0);
    await Malicious.approveAndStake(0);

    const stakeTime = await networkHelpers.time.latest();
    await networkHelpers.time.setNextBlockTimestamp(
      stakeTime + 7 * 24 * 60 * 60,
    );
    await Malicious.doUnstake(0);

    expect(await Malicious.unstakeReentered()).to.equal(true);
    expect(await Malicious.unstakeReentrySucceeded()).to.equal(false);
    expect(await nft.ownerOf(0)).to.equal(maliciousAddr);
  });

  // ─── I5: Access control ──────────────────────────────────────────────

  it("test_OwnerCanFundRewards — owner funds successfully", async function () {
    const { ethers, staking, owner } = await deployFixture({ funded: false });

    // now pool starts at 0, so the assertion is precise

    const fundAmount = ethers.parseEther("0.01");
    await (
      await staking.connect(owner).fundRewards({ value: fundAmount })
    ).wait();

    expect(await staking.rewardPool()).to.equal(fundAmount);
  });

  it("test_RevertWhen_NonOwnerFundsRewards", async function () {
    const { ethers, staking, victor } = await deployFixture();

    await expect(
      staking.connect(victor).fundRewards({ value: ethers.parseEther("0.01") }),
    ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
  });

  // ─── I4: Solvency ────────────────────────────────────────────────────

  it("test_RevertWhen_StakeWithoutFunding", async function () {
    const { nft, staking, victor } = await deployFixture({ funded: false });
    const stakingAddr = await staking.getAddress();

    await nft.connect(victor).approve(stakingAddr, 0);

    // Pool is empty — stake must revert, not silently succeed
    await expect(staking.connect(victor).stake(0)).to.be.revertedWith(
      "Pool underfunded",
    );
  });

  it("test_StakeReservesRewardFromPool", async function () {
    const { ethers, nft, staking, owner, victor } = await deployFixture({
      funded: false,
    });
    const stakingAddr = await staking.getAddress();

    await (
      await staking
        .connect(owner)
        .fundRewards({ value: ethers.parseEther("0.01") })
    ).wait();
    const poolBefore = await staking.rewardPool(); // 0.01

    await nft.connect(victor).approve(stakingAddr, 0);
    await staking.connect(victor).stake(0);

    /// Pool decremented by exactly REWARD_AMOUNT
    expect(await staking.rewardPool()).to.equal(
      poolBefore - ethers.parseEther("0.001"),
    );

    const stake = await staking.stakes(0);
    expect(stake.reward).to.equal(ethers.parseEther("0.001"));
  });

  it("test_UnstakeRecordsPendingWithdrawal — reward moves to pending on unstake", async function () {
    const { ethers, nft, staking, networkHelpers, victor } =
      await deployFixture();
    const stakingAddr = await staking.getAddress();

    await nft.connect(victor).approve(stakingAddr, 0);
    await staking.connect(victor).stake(0);

    const stakeTime = await networkHelpers.time.latest();
    await networkHelpers.time.setNextBlockTimestamp(
      stakeTime + 7 * 24 * 60 * 60,
    );

    expect(await staking.pendingWithdrawals(victor.address)).to.equal(0n);

    await staking.connect(victor).unstake(0);

    // Reward is owed, not paid
    expect(await staking.pendingWithdrawals(victor.address)).to.equal(
      ethers.parseEther("0.001"),
    );

    // NFT returned immediately; reward is separate
    expect(await nft.ownerOf(0)).to.equal(victor.address);
  });

  it("test_WithdrawPaysPending — withdraw sends pending ETH", async function () {
    const { ethers, nft, staking, networkHelpers, victor } =
      await deployFixture();
    const stakingAddr = await staking.getAddress();

    await nft.connect(victor).approve(stakingAddr, 0);
    await staking.connect(victor).stake(0);

    const stakeTime = await networkHelpers.time.latest();
    await networkHelpers.time.setNextBlockTimestamp(
      stakeTime + 7 * 24 * 60 * 60,
    );
    await staking.connect(victor).unstake(0);

    const balBefore = await ethers.provider.getBalance(victor.address);
    const receipt = await (await staking.connect(victor).withdraw()).wait();
    const gasCost = receipt.gasUsed * receipt.gasPrice;
    const balAfter = await ethers.provider.getBalance(victor.address);

    expect(balAfter - balBefore + gasCost).to.equal(ethers.parseEther("0.001"));
    expect(await staking.pendingWithdrawals(victor.address)).to.equal(0n);
  });

  it("test_RevertWhen_WithdrawWithoutPending — empty pending reverts", async function () {
    const { staking, victor } = await deployFixture();

    await expect(staking.connect(victor).withdraw()).to.be.revertedWith(
      "Nothing to withdraw",
    );
  });

  it("test_ReentrancyDuringWithdrawFails — ETH callback reentry blocked", async function () {
    const { ethers, networkHelpers, nft, staking, victor } =
      await deployFixture();
    const stakingAddr = await staking.getAddress();
    const nftAddr = await nft.getAddress();

    const Malicious = await ethers.deployContract("MaliciousReceiver", [
      stakingAddr,
      nftAddr,
    ]);
    await Malicious.waitForDeployment();
    const maliciousAddr = await Malicious.getAddress();

    await nft.connect(victor).transferFrom(victor.address, maliciousAddr, 0);
    await Malicious.approveAndStake(0);

    const stakeTime = await networkHelpers.time.latest();
    await networkHelpers.time.setNextBlockTimestamp(
      stakeTime + 7 * 24 * 60 * 60,
    );
    await Malicious.doUnstake(0);

    // Trigger withdraw — receive() will try to reenter withdraw
    await Malicious.doWithdraw();

    expect(await Malicious.withdrawReentered()).to.equal(true);
    expect(await Malicious.withdrawReentrySucceeded()).to.equal(false);
    expect(await staking.pendingWithdrawals(maliciousAddr)).to.equal(0n);
  });

  it("test_ContractSolvency — balance covers pool + active stakes + pending", async function () {
    const { ethers, nft, staking, victor, iyke } = await deployFixture();
    const stakingAddr = await staking.getAddress();

    await nft.mint(iyke.address);
    await nft.connect(victor).approve(stakingAddr, 0);
    await nft.connect(iyke).approve(stakingAddr, 1);
    await staking.connect(victor).stake(0);
    await staking.connect(iyke).stake(1);

    const balance = await ethers.provider.getBalance(stakingAddr);
    const pool = await staking.rewardPool();
    const stake0 = await staking.stakes(0);
    const stake1 = await staking.stakes(1);
    const pendingVictor = await staking.pendingWithdrawals(victor.address);
    const pendingIyke = await staking.pendingWithdrawals(iyke.address);

    // I4: contract balance covers every obligation
    expect(balance).to.be.gte(
      pool + stake0.reward + stake1.reward + pendingVictor + pendingIyke,
    );
  });

  it("test_DurationIsImmutable — STAKE_DURATION has no setter", async function () {
    const { staking } = await deployFixture();
    expect(await staking.STAKE_DURATION()).to.equal(7n * 24n * 60n * 60n);

    // No setter in ABI
    const abi = staking.interface.fragments.map((f) => f.name);
    expect(abi).to.not.include("setStakeDuration");
    expect(abi).to.not.include("setDuration");
  });

  it("test_NoOwnerWithdraw — no function drains pool or pending", async function () {
    const { staking, owner } = await deployFixture();

    const fnNames = staking.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name);

    // The user-facing withdraw is the only function that pays out ETH
    expect(fnNames).to.include("withdraw");

    // No owner-drain surfaces exist under any common name
    const DRAIN_NAMES = [
      "withdrawAll",
      "withdrawRewards",
      "emergencyWithdraw",
      "rescueETH",
      "sweep",
      "drain",
    ];
    for (const name of DRAIN_NAMES) {
      expect(fnNames).to.not.include(name);
    }

    // Even the owner calling withdraw() with no pending gets nothing, and pool is untouched
    const poolBefore = await staking.rewardPool();
    await expect(staking.connect(owner).withdraw()).to.be.revertedWith(
      "Nothing to withdraw",
    );
    expect(await staking.rewardPool()).to.equal(poolBefore);
  });
});
