import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const StakingModule = buildModule("StakingModule", (m) => {
  const nftAddress = m.getParameter("nftAddress");
  const initialOwner = m.getParameter("initialOwner");

  const staking = m.contract("Staking", [nftAddress, initialOwner]);

  return { staking };
});

export default StakingModule;
