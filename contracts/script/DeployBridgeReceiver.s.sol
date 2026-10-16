// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BridgeReceiver} from "../src/BridgeReceiver.sol";

/// Injective mainnet deploy, fully configured: the owning Safe signs nothing.
///
///   OWNER=<safe> SWEEPER=<relayer> forge script script/DeployBridgeReceiver.s.sol \
///     --rpc-url https://sentry.evm-rpc.injective.network --account <keystore> --broadcast
contract DeployBridgeReceiver is Script {
    address constant MESSAGE_TRANSMITTER_V2 = 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64;
    address constant USDC = 0xa00C59fF5a080D2b954d0c75e46E22a0c371235a;

    /// Ceilings no owner can ever exceed.
    uint256 constant MAX_DROP_WEI = 0.1 ether;
    uint256 constant MAX_DROP_FEE = 2e6;

    /// v1's offer: 0.02 INJ for 0.50 USDC, fixed.
    uint256 constant DROP_WEI = 0.02 ether;
    uint256 constant DROP_FEE = 0.5e6;

    function run() external returns (BridgeReceiver r) {
        require(block.chainid == 1776, "not Injective mainnet");
        address owner = vm.envAddress("OWNER");
        address sweeper = vm.envAddress("SWEEPER");
        require(owner.code.length > 0, "owner must be the Safe, not an EOA");
        require(sweeper != address(0), "sweeper unset");

        vm.startBroadcast();
        r = new BridgeReceiver(
            MESSAGE_TRANSMITTER_V2, USDC, owner, MAX_DROP_WEI, MAX_DROP_FEE, DROP_WEI, DROP_FEE, sweeper
        );
        vm.stopBroadcast();

        console.log("BridgeReceiver", address(r));
    }
}
