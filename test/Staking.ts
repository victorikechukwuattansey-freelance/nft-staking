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

  it("test_ReentrancyDuringUnstakeFails — CEI blocks reentry", async function () {
    const { ethers, networkHelpers, nft, staking, victor } =
      await deployFixture();
    const stakingAddr = await staking.getAddress();
    const nftAddr = await nft.getAddress();

    // Deploy the adversarial staker
    const Malicious = await ethers.deployContract("MaliciousReceiver", [
      stakingAddr,
      nftAddr,
    ]);
    await Malicious.waitForDeployment();
    const maliciousAddr = await Malicious.getAddress();

    // Give the malicious receiver token 0 (currently held by victor).
    // transferFrom (not safeTransferFrom) — no callback, no reentry here.
    await nft.connect(victor).transferFrom(victor.address, maliciousAddr, 0);

    // Receiver stakes it
    await Malicious.approveAndStake(0);

    // Warp to exactly the lockup boundary
    const stakeTime = await networkHelpers.time.latest();
    await networkHelpers.time.setNextBlockTimestamp(
      stakeTime + 7 * 24 * 60 * 60,
    );

    // The malicious receiver unstakes itself — reentry fires during the callback
    await Malicious.doUnstake(0);

    // I6: the reentry was attempted, but failed — state was already deleted
    expect(await Malicious.reentered()).to.equal(true);
    expect(await Malicious.reentrySucceeded()).to.equal(false);

    // I1: only one NFT was moved, state is consistent
    expect(await nft.ownerOf(0)).to.equal(maliciousAddr);
    expect(await nft.balanceOf(stakingAddr)).to.equal(0);

    // I3: the stake is deleted
    const stake = await staking.stakes(0);
    expect(stake.owner).to.equal(ethers.ZeroAddress);
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

  it("test_UnstakePaysExactReward", async function () {
    const { ethers, nft, staking, networkHelpers, owner, victor } =
      await deployFixture({ funded: false });
    const stakingAddr = await staking.getAddress();

    await staking
      .connect(owner)
      .fundRewards({ value: ethers.parseEther("0.01") });
    await nft.connect(victor).approve(stakingAddr, 0);
    await staking.connect(victor).stake(0);

    const stakeTime = await networkHelpers.time.latest();
    await networkHelpers.time.setNextBlockTimestamp(
      stakeTime + 7 * 24 * 60 * 60,
    );

    const balBefore = await ethers.provider.getBalance(victor.address);
    const tx = await staking.connect(victor).unstake(0);
    const receipt = await tx.wait();
    const gasCost = receipt.gasUsed * receipt.gasPrice;
    const balAfter = await ethers.provider.getBalance(victor.address);

    // Balance increase minus gas paid must equal exactly REWARD_AMOUNT
    expect(balAfter - balBefore + gasCost).to.equal(ethers.parseEther("0.001"));
  });
});
