import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("Staking — I1 Escrow Consistency", function () {
  async function deployFixture() {
    const [owner, victor, iyke] = await ethers.getSigners();

    const nft = await ethers.deployContract("MockNFT");
    await nft.waitForDeployment();

    // Mint token 0 to victor
    await nft.mint(victor.address);

    const staking = await ethers.deployContract("Staking", [
      await nft.getAddress(),
    ]);
    await staking.waitForDeployment();

    return { nft, staking, owner, victor, iyke };
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

    // Victor does NOT approve. stake must revert — safeTransferFrom needs approval.
    await expect(staking.connect(victor).stake(0)).to.revert(ethers);
     // I1: contract balance stays 0
    expect(await nft.balanceOf(stakingAddr)).to.equal(0);
  });
});
