import { expect } from "chai";
import { network } from "hardhat";

// const { ethers } = await network.create();

describe("Staking — lifecycle (I1, I2, I3, I7)", function () {
  async function deployFixture() {
    const { ethers, networkHelpers } = await network.create(); // or network.create()
    const [owner, victor, iyke] = await ethers.getSigners();

    const nft = await ethers.deployContract("MockNFT");
    await nft.waitForDeployment();

    // Mint token 0 to victor
    await nft.mint(victor.address);

    const staking = await ethers.deployContract("Staking", [
      await nft.getAddress(),
    ]);
    await staking.waitForDeployment();

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
});
