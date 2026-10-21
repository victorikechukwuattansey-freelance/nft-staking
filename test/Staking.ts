import { expect } from "chai";
import { network } from "hardhat";

// const { ethers } = await network.create();

describe("Staking — I1 (escrow) + I2 (authorization)", function () {
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
    await expect(staking.connect(victor).stake(0))
      .to.be.revertedWithCustomError(nft, "ERC721InsufficientApproval");

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
});
