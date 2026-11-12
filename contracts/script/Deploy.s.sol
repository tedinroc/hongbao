// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Hongbao} from "../src/Hongbao.sol";

/// @notice Deploys Hongbao wired to Mezo's own contracts.
/// Env: TREASURY and GUARDIAN (default: the broadcaster).
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast --private-key $PK
contract Deploy is Script {
    function wiring(uint256 chainId, address treasury, address guardian) public pure returns (Hongbao.Wiring memory w) {
        if (chainId == 31612) {
            // Mezo mainnet — capped beta
            w = Hongbao.Wiring({
                musd: 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186,
                smusd: 0xb4D498029af77680cD1eF828b967f010d06C51CC,
                gauge: 0x677817bF3e44b90E8F95222F75e2950b7904a401,
                priceFeed: 0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88,
                router: 0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706,
                btc: 0x7b7C000000000000000000000000000000000000,
                poolFactory: 0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248,
                treasury: treasury,
                guardian: guardian,
                feeBps: 100,
                maxPerPacket: 50e18,
                maxPerSender: 100e18,
                maxOutstanding: 500e18,
                hardMaxPerPacket: 100e18,
                hardMaxPerSender: 500e18,
                hardMaxOutstanding: 5_000e18
            });
        } else if (chainId == 31611) {
            // Mezo testnet (Matsnet)
            w = Hongbao.Wiring({
                musd: 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503,
                smusd: 0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16,
                gauge: 0xA6972f35550717280f2538EA77638B29073e3F07,
                priceFeed: 0x86bCF0841622a5dAC14A313a15f96A95421b9366,
                router: 0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9,
                btc: 0x7b7C000000000000000000000000000000000000,
                poolFactory: 0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A,
                treasury: treasury,
                guardian: guardian,
                feeBps: 100,
                maxPerPacket: 1_000e18,
                maxPerSender: 2_000e18,
                maxOutstanding: 20_000e18,
                hardMaxPerPacket: 1_000e18,
                hardMaxPerSender: 5_000e18,
                hardMaxOutstanding: 50_000e18
            });
        } else {
            revert("unsupported chain");
        }
    }

    function run() external returns (Hongbao hb) {
        address me = msg.sender;
        address treasury = vm.envOr("TREASURY", me);
        address guardian = vm.envOr("GUARDIAN", me);
        Hongbao.Wiring memory w = wiring(block.chainid, treasury, guardian);
        vm.startBroadcast();
        hb = new Hongbao(w);
        vm.stopBroadcast();
        console2.log("Hongbao deployed at", address(hb));
        console2.log("chain", block.chainid);
        console2.log("treasury", treasury);
        console2.log("guardian", guardian);
    }
}
