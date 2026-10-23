import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const StakingDemoModule = buildModule("StakingDemoModule", (m) => {
  const nftAddress = m.getParameter("nftAddress");
  const initialOwner = m.getParameter("initialOwner");
  const staking = m.contract("StakingDemo", [nftAddress, initialOwner]);
  return { staking };
});

export default StakingDemoModule;
