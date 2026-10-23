# Sepolia Deployments

All contracts verified on Etherscan and Sourcify.

| Contract | Address | Duration | Purpose |
| :--- | :--- | :--- | :--- |
| `MyNFT` | [`0xc91c85…0940`](https://sepolia.etherscan.io/address/0xc91c858497795bE246E4f6aBe0627969A2b60940) | — | ERC-721 collection (from `my-nft` repo) |
| `Staking` | [`0x27DbE8…9aaE`](https://sepolia.etherscan.io/address/0x27DbE8BBB484BF8885d856d7f66182A7f3189aaE) | 7 days | Production-shaped `v1.1.0` |
| `StakingDemo` | [`0xF96DF2…913d`](https://sepolia.etherscan.io/address/0xF96DF232c796c1ac9B5a18700AF487AF090B913d) | 60 sec | Same logic, for live full-cycle verification |

**Deployer / owner:** `0x087F7E99b750054e20291fdA8de18D4b1D68866f`

## Live state (at time of documentation)

**`Staking` (production):**
- `rewardPool` = 0.009 ETH
- One active stake: tokenId 0, staker `0x087F…866f`, started `1792740768`, reward `1e15`
- Unlocks ≈ Oct 30, 2026 (7 days from stake)

**`StakingDemo`:**
- Full lifecycle `stake → unstake → withdraw` completed on-chain
- `rewardPool` = 0, `pendingWithdrawals[0x087F…866f]` = 0
- Token 1 returned to `0x087F…866f`

## Verified transactions (demo cycle)

| Action | Tx |
| :--- | :--- |
| Fund (`fundRewards`) | `0x2471c5a636ebe4ca089e67d215a0e44c7ae6a0fdd753c604c7b6aadf697e607b` |
| Mint NFT #1 | `0x1cbd47a8973df17158e3ce7bef210472207e4f0de7ea69fa34387a0f4036f54e` |
| Approve demo | `0xe90b9e3f722bd3123250c734416db4ad62fec8b526e1c651ddd8be59345db42c` |
| Stake #1 | `0x24076144c9ab563c59570fbede055438589b330b0b886f2afbd775db796616e4` |
| Unstake #1 | `0xd46b88ad177cdae4bde300f6c6760714bc1a6025607682f2d8fddb03c84e42f4` |
| Withdraw | `0x98640108dbb03368a7cb27460ea183380b747a03b9888e7c2994b07f6accba51` |

Each row is a click-through on Etherscan: the tx log shows the state transitions
above in `Staked`, `Unstaked`, `Withdrawn`, and `Transfer` events.
