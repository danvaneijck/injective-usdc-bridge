// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {BridgeReceiver} from "../src/BridgeReceiver.sol";
import {MockMessageTransmitter, MockUSDC, NoReceive, Reenterer} from "./Mocks.sol";

contract BridgeReceiverTest is Test {
    MockUSDC usdc;
    MockMessageTransmitter mt;
    BridgeReceiver r;

    address owner = makeAddr("owner");
    address pricer = makeAddr("pricer");
    address sweeper = makeAddr("sweeper");
    address user = makeAddr("user");
    address anyone = makeAddr("anyone");

    uint256 constant MAX_DROP_WEI = 0.1 ether;
    uint256 constant MAX_DROP_FEE = 2e6;
    uint256 constant DROP_WEI = 0.02 ether;
    uint256 constant DROP_FEE = 0.25e6;
    uint256 constant MIN_DROP_FEE = 0.1e6;

    uint256 nonceSeq;

    function setUp() public {
        usdc = new MockUSDC();
        mt = new MockMessageTransmitter(usdc);
        r = new BridgeReceiver(address(mt), address(usdc), owner, MAX_DROP_WEI, MAX_DROP_FEE);
        vm.startPrank(owner);
        r.setDropConfig(DROP_WEI, MIN_DROP_FEE);
        r.setDropFee(DROP_FEE);
        r.setPricer(pricer);
        r.setSweeper(sweeper);
        vm.stopPrank();
        vm.deal(address(r), 1 ether);
    }

    // -----------------------------------------------------------------
    // Message builders (real MessageV2 + BurnMessageV2 layout)
    // -----------------------------------------------------------------

    function _hook(address recipient, uint256 maxDropFee) internal pure returns (bytes memory) {
        return abi.encode(bytes4(0x49554231), recipient, maxDropFee);
    }

    function _msg(bytes32 mintRecipient, bytes32 caller, bytes32 sender, uint256 amount, uint256 feeExecuted, bytes memory hook)
        internal
        returns (bytes memory)
    {
        bytes memory header = abi.encodePacked(
            uint32(1), uint32(6), uint32(29), bytes32(++nonceSeq), bytes32(uint256(1)), bytes32(uint256(2)),
            caller, uint32(2000), uint32(2000)
        );
        bytes memory body = abi.encodePacked(
            uint32(1), bytes32(uint256(uint160(address(usdc)))), mintRecipient, amount, sender,
            uint256(0), feeExecuted, uint256(0), hook
        );
        return bytes.concat(header, body);
    }

    function _b32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _ours(uint256 amount, bytes memory hook) internal returns (bytes memory) {
        return _msg(_b32(address(r)), _b32(address(r)), _b32(user), amount, 0, hook);
    }

    function _relay(bytes memory m) internal {
        vm.prank(anyone);
        r.relay(m, "");
    }

    // -----------------------------------------------------------------
    // Happy paths
    // -----------------------------------------------------------------

    function test_dropAndPay() public {
        _relay(_ours(10e6, _hook(user, 0.5e6)));
        assertEq(usdc.balanceOf(user), 10e6 - DROP_FEE);
        assertEq(user.balance, DROP_WEI);
        assertEq(r.accruedFees(), DROP_FEE);
        assertEq(r.strayBalance(), 0);
    }

    function test_noDropRequestedPaysEverything() public {
        _relay(_ours(10e6, _hook(user, 0)));
        assertEq(usdc.balanceOf(user), 10e6);
        assertEq(user.balance, 0);
        assertEq(r.accruedFees(), 0);
    }

    /// Same bytes as packages/bridge/test/gasDrop.test.ts HOOK_VECTOR.
    function test_tsHookVectorParses() public {
        address tsUser = 0x73Fcb2D05F2e29561B58177aF7f22ac19b3B484f;
        bytes memory hook = bytes.concat(
            hex"4955423100000000000000000000000000000000000000000000000000000000",
            hex"00000000000000000000000073fcb2d05f2e29561b58177af7f22ac19b3b484f",
            hex"000000000000000000000000000000000000000000000000000000000007a120"
        );
        assertEq(hook, _hook(tsUser, 500_000));
        _relay(_ours(10e6, hook));
        assertEq(usdc.balanceOf(tsUser), 10e6 - DROP_FEE);
        assertEq(tsUser.balance, DROP_WEI);
    }

    function test_relayIsPermissionless() public {
        bytes memory m = _ours(5e6, _hook(user, 1e6));
        vm.prank(makeAddr("random-stranger"));
        r.relay(m, "");
        assertEq(usdc.balanceOf(user), 5e6 - DROP_FEE);
    }

    // -----------------------------------------------------------------
    // Drops that cannot be honoured skip, never revert, never charge
    // -----------------------------------------------------------------

    function _expectSkip(uint8 reason) internal {
        vm.expectEmit(false, true, false, true, address(r));
        emit BridgeReceiver.DropSkipped(bytes32(0), user, reason);
    }

    function test_skip_paused() public {
        vm.prank(owner);
        r.setDropsPaused(true);
        _expectSkip(1);
        _relay(_ours(10e6, _hook(user, 1e6)));
        assertEq(usdc.balanceOf(user), 10e6);
        assertEq(user.balance, 0);
    }

    function test_skip_dropsDisabled() public {
        vm.prank(owner);
        r.setDropConfig(0, MIN_DROP_FEE);
        _expectSkip(2);
        _relay(_ours(10e6, _hook(user, 1e6)));
        assertEq(usdc.balanceOf(user), 10e6);
    }

    function test_skip_feeAboveUsersMax() public {
        _expectSkip(3);
        _relay(_ours(10e6, _hook(user, DROP_FEE - 1)));
        assertEq(usdc.balanceOf(user), 10e6);
        assertEq(user.balance, 0);
    }

    function test_skip_floatTooLow() public {
        vm.deal(address(r), DROP_WEI - 1);
        _expectSkip(4);
        _relay(_ours(10e6, _hook(user, 1e6)));
        assertEq(usdc.balanceOf(user), 10e6);
    }

    /// v1 reverted SponsorFeeExceedsMinted here and the burn was locked forever.
    function test_skip_amountTooSmallStillDelivers() public {
        _expectSkip(5);
        _relay(_ours(DROP_FEE, _hook(user, 1e6)));
        assertEq(usdc.balanceOf(user), DROP_FEE);
        assertEq(r.accruedFees(), 0);
    }

    function test_skip_recipientRefusesInj_refundsFee() public {
        address c = address(new NoReceive());
        vm.expectEmit(false, true, false, true, address(r));
        emit BridgeReceiver.DropSkipped(bytes32(0), c, 6);
        _relay(_msg(_b32(address(r)), _b32(address(r)), _b32(user), 10e6, 0, _hook(c, 1e6)));
        assertEq(usdc.balanceOf(c), 10e6);
        assertEq(c.balance, 0);
        assertEq(r.accruedFees(), 0);
        assertEq(address(r).balance, 1 ether);
    }

    function test_reentrancyFromDropIsBlocked() public {
        Reenterer evil = new Reenterer();
        bytes memory second = _msg(_b32(address(r)), _b32(address(r)), _b32(user), 1e6, 0, _hook(address(evil), 1e6));
        bytes32 secondNonce = bytes32(nonceSeq);
        evil.arm(address(r), second);
        _relay(_msg(_b32(address(r)), _b32(address(r)), _b32(user), 10e6, 0, _hook(address(evil), 1e6)));
        assertTrue(evil.attempted());
        assertFalse(evil.reentered());
        // The recipient swallowed its failed re-entry and accepted the INJ,
        // so the drop counts and its fee is charged.
        assertEq(usdc.balanceOf(address(evil)), 10e6 - DROP_FEE);
        assertEq(address(evil).balance, DROP_WEI);
        assertEq(mt.usedNonces(secondNonce), 0);
        // The message it tried to sneak in is still unused and completes normally.
        _relay(second);
        assertEq(usdc.balanceOf(address(evil)), 11e6 - 2 * DROP_FEE);
        assertEq(usdc.balanceOf(address(r)), r.accruedFees());
    }

    // -----------------------------------------------------------------
    // Escrow
    // -----------------------------------------------------------------

    function test_blacklistedRecipientIsEscrowedAndClaimsElsewhere() public {
        usdc.setBlocked(user, true);
        _relay(_ours(10e6, _hook(user, 0)));
        assertEq(r.escrow(_b32(user)), 10e6);
        assertEq(r.totalEscrow(), 10e6);
        address safe = makeAddr("safe");
        vm.prank(user);
        r.claim(safe);
        assertEq(usdc.balanceOf(safe), 10e6);
        assertEq(r.totalEscrow(), 0);
    }

    function test_malformedHookEscrowsForEvmSender() public {
        _relay(_msg(_b32(address(r)), _b32(address(r)), _b32(user), 7e6, 0, hex"deadbeef"));
        assertEq(r.escrow(_b32(user)), 7e6);
        vm.prank(user);
        r.claim(user);
        assertEq(usdc.balanceOf(user), 7e6);
    }

    function test_malformedHookFromNonEvmSenderReassignableByOwnerOnly() public {
        bytes32 solanaKey = keccak256("solana-sender");
        _relay(_msg(_b32(address(r)), _b32(address(r)), solanaKey, 3e6, 0, _hook(address(0), 0)));
        assertEq(r.escrow(solanaKey), 3e6);

        vm.prank(anyone);
        vm.expectRevert();
        r.reassignEscrow(solanaKey, anyone);

        vm.prank(owner);
        r.reassignEscrow(solanaKey, user);
        vm.prank(user);
        r.claim(user);
        assertEq(usdc.balanceOf(user), 3e6);
    }

    function test_ownerCannotReassignEvmEscrow() public {
        usdc.setBlocked(user, true);
        _relay(_ours(10e6, _hook(user, 0)));
        vm.prank(owner);
        vm.expectRevert(BridgeReceiver.EvmEscrowNotReassignable.selector);
        r.reassignEscrow(_b32(user), owner);
    }

    function test_hookWithDirtyAddressBitsIsInvalid() public {
        bytes memory hook = abi.encode(bytes4(0x49554231), bytes32(uint256(1) << 200 | uint256(uint160(user))), uint256(0));
        _relay(_msg(_b32(address(r)), _b32(address(r)), _b32(user), 2e6, 0, hook));
        assertEq(r.escrow(_b32(user)), 2e6);
        assertEq(usdc.balanceOf(user), 0);
    }

    // -----------------------------------------------------------------
    // Pass-through and stray mints
    // -----------------------------------------------------------------

    function test_passThroughWhenMintIsNotOurs() public {
        bytes memory m = _msg(_b32(user), _b32(address(r)), _b32(user), 4e6, 0, "");
        _relay(m);
        assertEq(usdc.balanceOf(user), 4e6);
        assertEq(usdc.balanceOf(address(r)), 0);
    }

    function test_directMtCallLeavesStrayOwnerRecovers() public {
        bytes memory m = _msg(_b32(address(r)), bytes32(0), _b32(user), 6e6, 0, _hook(user, 0));
        mt.receiveMessage(m, "");
        assertEq(r.strayBalance(), 6e6);
        vm.prank(anyone);
        vm.expectRevert("Nonce already used");
        r.relay(m, "");
        vm.prank(owner);
        r.recoverStray(user, 6e6);
        assertEq(usdc.balanceOf(user), 6e6);
    }

    function test_strayRecoveryCannotTouchFeesOrEscrow() public {
        _relay(_ours(10e6, _hook(user, 1e6)));
        usdc.setBlocked(anyone, true);
        _relay(_msg(_b32(address(r)), _b32(address(r)), _b32(user), 5e6, 0, _hook(anyone, 0)));
        assertEq(r.strayBalance(), 0);
        vm.prank(owner);
        vm.expectRevert(BridgeReceiver.ExceedsAvailable.selector);
        r.recoverStray(owner, 1);
    }

    function test_nonceCannotBeRelayedTwice() public {
        bytes memory m = _ours(1e6, _hook(user, 0));
        _relay(m);
        vm.expectRevert("Nonce already used");
        _relay(m);
    }

    function test_feeExecutedByCircleIsRespected() public {
        _relay(_msg(_b32(address(r)), _b32(address(r)), _b32(user), 10e6, 1300, _hook(user, 0)));
        assertEq(usdc.balanceOf(user), 10e6 - 1300);
    }

    // -----------------------------------------------------------------
    // Bridge fee (0 today) and roles
    // -----------------------------------------------------------------

    function test_bridgeFeeCappedAndCharged() public {
        vm.startPrank(owner);
        vm.expectRevert(BridgeReceiver.AboveCeiling.selector);
        r.setFeeBps(51);
        r.setFeeBps(30);
        vm.stopPrank();
        _relay(_ours(10e6, _hook(user, 1e6)));
        uint256 bridgeFee = 10e6 * 30 / 10_000;
        assertEq(usdc.balanceOf(user), 10e6 - DROP_FEE - bridgeFee);
        assertEq(r.accruedFees(), DROP_FEE + bridgeFee);
    }

    function test_pricerBoundsAndPauseOnly() public {
        vm.startPrank(pricer);
        r.setDropFee(0.5e6);
        vm.expectRevert(BridgeReceiver.AboveCeiling.selector);
        r.setDropFee(MAX_DROP_FEE + 1);
        vm.expectRevert(BridgeReceiver.BelowFloor.selector);
        r.setDropFee(MIN_DROP_FEE - 1);
        r.setDropsPaused(true);
        vm.expectRevert(BridgeReceiver.Unauthorized.selector);
        r.setDropsPaused(false);
        vm.expectRevert();
        r.setDropConfig(DROP_WEI, 0);
        vm.stopPrank();
    }

    function test_ownerCannotExceedImmutableCeilings() public {
        vm.startPrank(owner);
        vm.expectRevert(BridgeReceiver.AboveCeiling.selector);
        r.setDropConfig(MAX_DROP_WEI + 1, MIN_DROP_FEE);
        vm.expectRevert(BridgeReceiver.AboveCeiling.selector);
        r.setDropConfig(DROP_WEI, MAX_DROP_FEE + 1);
        vm.stopPrank();
    }

    function test_sweeperOnlyToSelfAndOnlyFees() public {
        _relay(_ours(10e6, _hook(user, 1e6)));
        vm.startPrank(sweeper);
        vm.expectRevert(BridgeReceiver.SweeperMustSweepToSelf.selector);
        r.sweepFees(DROP_FEE, anyone);
        vm.expectRevert(BridgeReceiver.ExceedsAvailable.selector);
        r.sweepFees(DROP_FEE + 1, sweeper);
        r.sweepFees(DROP_FEE, sweeper);
        vm.stopPrank();
        assertEq(usdc.balanceOf(sweeper), DROP_FEE);
        assertEq(r.accruedFees(), 0);
    }

    function test_renounceDisabled() public {
        vm.prank(owner);
        vm.expectRevert(BridgeReceiver.RenounceDisabled.selector);
        r.renounceOwnership();
    }

    // -----------------------------------------------------------------
    // Conservation
    // -----------------------------------------------------------------

    /// Every minted unit ends up paid, accrued as fee, or escrowed.
    function testFuzz_conservation(uint96 amount, uint96 userMax, uint16 bps, bool blocked, uint96 floatWei)
        public
    {
        amount = uint96(bound(amount, 1, 1e15));
        bps = uint16(bound(bps, 0, 50));
        vm.prank(owner);
        r.setFeeBps(bps);
        vm.deal(address(r), bound(floatWei, 0, 1 ether));
        usdc.setBlocked(user, blocked);
        uint256 floatBefore = address(r).balance;

        _relay(_ours(amount, _hook(user, userMax)));

        uint256 held = usdc.balanceOf(address(r));
        assertEq(held, r.accruedFees() + r.totalEscrow());
        assertEq(usdc.balanceOf(user) + held, amount);
        assertEq(floatBefore - address(r).balance, user.balance);
        assertLe(r.accruedFees(), amount);
    }
}
