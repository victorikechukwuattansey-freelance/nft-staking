// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @dev Minimal ERC-721 for staking tests. Anyone can mint.
///      Not for production — no access control, no metadata.
contract MockNFT is ERC721 {
    uint256 private _nextId;

    constructor() ERC721("MockNFT", "MNFT") {}

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}
