// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Hongbao} from "../src/Hongbao.sol";
import {
    MockMUSD,
    MockSavings,
    MockVoter,
    MockGauge,
    MockPriceFeed,
    MockBTC,
    MockRouter,
    RevertingReceiver
} from "./mocks/Mocks.sol";

contract HongbaoTest is Test {
    Hongbao hb;
    MockMUSD musd;
    MockSavings smusd;
    MockVoter voter;
    MockGauge gauge;
    MockPriceFeed feed;
    MockBTC btc;
    MockRouter router;

    address treasury = makeAddr("treasury");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice"); // sender
    address relayer = makeAddr("relayer");
    address factory = makeAddr("factory");

    uint256 keyPk = 0xA11CE;
    address key;
    uint256 attesterPk = 0xA77E57;
    address attester;

    uint96 constant DRIP = 0.000002 ether;
    uint96 constant TIP = 0.0000006 ether;

    function setUp() public {
        vm.warp(1_800_000_000);
        key = vm.addr(keyPk);
        attester = vm.addr(attesterPk);

        musd = new MockMUSD();
        smusd = new MockSavings(musd);
        voter = new MockVoter();
        gauge = new MockGauge(address(smusd), address(voter));
        voter.setAlive(address(gauge), true);
        feed = new MockPriceFeed();
        btc = new MockBTC();
        router = new MockRouter(btc, musd);

        hb = new Hongbao(
            Hongbao.Wiring({
                musd: address(musd),
                smusd: address(smusd),
                gauge: address(gauge),
                priceFeed: address(feed),
                router: address(router),
                btc: address(btc),
                poolFactory: factory,
                treasury: treasury,
                guardian: guardian,
                feeBps: 100,
                hardMaxPerPacket: 50e18,
                hardMaxOutstanding: 500e18
            })
        );

        musd.mint(alice, 1_000e18);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        musd.approve(address(hb), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _params(uint32 shares) internal view returns (Hongbao.CreateParams memory) {
        return Hongbao.CreateParams({
            shares: shares,
            expiry: uint64(block.timestamp + 1 days),
            claimKey: key,
            attester: address(0),
            dripPerShare: DRIP,
            tipPerShare: TIP,
            message: unicode"新年快樂"
        });
    }

    function _create(uint256 amount, uint32 shares) internal returns (uint256 id) {
        Hongbao.CreateParams memory p = _params(shares);
        vm.prank(alice);
        id = hb.create{value: uint256(shares) * (DRIP + TIP)}(amount, p);
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _claim(uint256 id, address to, Hongbao.Payout payout) internal returns (uint256 amt, Hongbao.Payout paid) {
        bytes memory sig = _sig(keyPk, hb.claimDigest(id, to, payout));
        vm.prank(relayer);
        (amt, paid) = hb.claim(id, to, payout, sig, 0, "");
    }

    // ------------------------------------------------------------------ create

    function test_createHoldsSavingsAndPaysFee() public {
        uint256 id = _create(20e18, 10);
        assertEq(id, 1);
        assertEq(musd.balanceOf(treasury), 0.2e18, "1% fee");
        assertEq(smusd.balanceOf(address(hb)), 19.8e18, "net held as sMUSD");
        assertEq(musd.balanceOf(address(hb)), 0, "no idle MUSD");
        assertEq(hb.outstanding(), 19.8e18);
        assertEq(address(hb).balance, 10 * uint256(DRIP + TIP), "gas kits held");
        Hongbao.Packet memory p = hb.getPacket(id);
        assertEq(p.sender, alice);
        assertEq(p.sharesLeft, 10);
        assertEq(p.remaining, 19.8e18);
        (uint256 packets,, uint256 volume,, uint256 senders, uint256 open) = hb.stats();
        assertEq(packets, 1);
        assertEq(volume, 19.8e18);
        assertEq(senders, 1);
        assertEq(open, 19.8e18);
    }

    function test_createRejectsBadInputs() public {
        Hongbao.CreateParams memory p = _params(10);
        vm.startPrank(alice);

        vm.expectRevert(Hongbao.BadValue.selector);
        hb.create{value: 1}(20e18, p);

        p.shares = 0;
        vm.expectRevert(Hongbao.BadValue.selector); // value check first: 0 shares => value must be 0
        hb.create{value: 1}(20e18, p);
        vm.expectRevert(Hongbao.BadShares.selector);
        hb.create(20e18, p);

        p = _params(101);
        vm.expectRevert(Hongbao.BadShares.selector);
        hb.create{value: 101 * uint256(DRIP + TIP)}(20e18, p);

        p = _params(10);
        p.expiry = uint64(block.timestamp + 5 minutes);
        vm.expectRevert(Hongbao.BadExpiry.selector);
        hb.create{value: 10 * uint256(DRIP + TIP)}(20e18, p);

        p = _params(10);
        p.expiry = uint64(block.timestamp + 31 days);
        vm.expectRevert(Hongbao.BadExpiry.selector);
        hb.create{value: 10 * uint256(DRIP + TIP)}(20e18, p);

        p = _params(10);
        p.claimKey = address(0);
        vm.expectRevert(Hongbao.BadKey.selector);
        hb.create{value: 10 * uint256(DRIP + TIP)}(20e18, p);

        p = _params(10);
        p.dripPerShare = uint96(hb.MAX_DRIP() + 1);
        vm.expectRevert(Hongbao.BadGasKit.selector);
        hb.create{value: 10 * (uint256(p.dripPerShare) + TIP)}(20e18, p);

        p = _params(100);
        vm.expectRevert(Hongbao.ShareTooSmall.selector); // 0.99 net / 100 < 0.01
        hb.create{value: 100 * uint256(DRIP + TIP)}(1e18, p);

        p = _params(10);
        vm.expectRevert(Hongbao.OverPacketCap.selector);
        hb.create{value: 10 * uint256(DRIP + TIP)}(51e18, p);

        p = _params(10);
        p.message = string(new bytes(201));
        vm.expectRevert(Hongbao.MessageTooLong.selector);
        hb.create{value: 10 * uint256(DRIP + TIP)}(20e18, p);
        vm.stopPrank();
    }

    function test_outstandingCap() public {
        for (uint256 i; i < 10; i++) {
            _create(50e18, 5);
        }
        assertEq(hb.outstanding(), 495e18);
        Hongbao.CreateParams memory p = _params(5);
        vm.prank(alice);
        vm.expectRevert(Hongbao.OverOutstandingCap.selector);
        hb.create{value: 5 * uint256(DRIP + TIP)}(10e18, p);
    }

    function test_createWithPermit() public {
        uint256 bobPk = 0xB0B;
        address bob = vm.addr(bobPk);
        musd.mint(bob, 30e18);
        vm.deal(bob, 1 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                bob,
                address(hb),
                30e18,
                musd.nonces(bob),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", musd.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bobPk, digest);

        // Someone front-runs the permit; creation must still succeed.
        musd.permit(bob, address(hb), 30e18, deadline, v, r, s);

        Hongbao.CreateParams memory p = _params(3);
        vm.prank(bob);
        uint256 id = hb.createWithPermit{value: 3 * uint256(DRIP + TIP)}(30e18, p, deadline, v, r, s);
        assertEq(hb.getPacket(id).remaining, 29.7e18);
    }

    // ------------------------------------------------------------------ claim

    function test_claimStakeSaveCash() public {
        uint256 id = _create(30e18, 3); // net 29.7, 9.9 each
        address r1 = makeAddr("r1");
        address r2 = makeAddr("r2");
        address r3 = makeAddr("r3");

        (uint256 a1, Hongbao.Payout p1) = _claim(id, r1, Hongbao.Payout.Stake);
        assertEq(a1, 9.9e18);
        assertEq(uint8(p1), uint8(Hongbao.Payout.Stake));
        assertEq(gauge.balanceOf(r1), 9.9e18, "staked in recipient's name");
        assertEq(smusd.allowance(address(hb), address(gauge)), 0, "allowance consumed");

        (uint256 a2, Hongbao.Payout p2) = _claim(id, r2, Hongbao.Payout.Save);
        assertEq(a2, 9.9e18);
        assertEq(uint8(p2), uint8(Hongbao.Payout.Save));
        assertEq(smusd.balanceOf(r2), 9.9e18);

        (uint256 a3, Hongbao.Payout p3) = _claim(id, r3, Hongbao.Payout.Cash);
        assertEq(a3, 9.9e18);
        assertEq(uint8(p3), uint8(Hongbao.Payout.Cash));
        assertEq(musd.balanceOf(r3), 9.9e18);

        assertEq(hb.outstanding(), 0);
        assertEq(smusd.balanceOf(address(hb)), 0);
        assertEq(hb.getPacket(id).sharesLeft, 0);

        // gas: each recipient got a drip, relayer got three tips, contract is empty
        assertEq(r1.balance, DRIP);
        assertEq(r2.balance, DRIP);
        assertEq(r3.balance, DRIP);
        assertEq(relayer.balance, 3 * uint256(TIP));
        assertEq(address(hb).balance, 0);

        (, uint256 claims,, uint256 recipients,,) = hb.stats();
        assertEq(claims, 3);
        assertEq(recipients, 3);
    }

    function test_lastShareTakesRemainder() public {
        uint256 id = _create(10e18, 3); // net 9.9 -> 3.3, 3.3, 3.3
        uint256 total;
        for (uint256 i; i < 3; i++) {
            (uint256 a,) = _claim(id, makeAddr(string(abi.encode(i))), Hongbao.Payout.Save);
            total += a;
        }
        assertEq(total, 9.9e18);

        uint256 id2 = _create(1e18, 7); // net 0.99 / 7 does not divide evenly
        total = 0;
        for (uint256 i; i < 7; i++) {
            (uint256 a,) = _claim(id2, makeAddr(string(abi.encode("b", i))), Hongbao.Payout.Save);
            total += a;
        }
        assertEq(total, 0.99e18);
        assertEq(hb.outstanding(), 0);
    }

    function test_claimRejections() public {
        uint256 id = _create(20e18, 2);
        address r = makeAddr("r");
        bytes memory sig = _sig(keyPk, hb.claimDigest(id, r, Hongbao.Payout.Stake));

        vm.expectRevert(Hongbao.UnknownPacket.selector);
        hb.claim(99, r, Hongbao.Payout.Stake, sig, 0, "");

        // signature for one payout cannot be used for another
        vm.expectRevert(Hongbao.BadSignature.selector);
        hb.claim(id, r, Hongbao.Payout.Cash, sig, 0, "");

        // signature for one recipient cannot redirect to another
        vm.expectRevert(Hongbao.BadSignature.selector);
        hb.claim(id, makeAddr("thief"), Hongbao.Payout.Stake, sig, 0, "");

        // wrong key
        bytes memory bad = _sig(0xBAD, hb.claimDigest(id, r, Hongbao.Payout.Stake));
        vm.expectRevert(Hongbao.BadSignature.selector);
        hb.claim(id, r, Hongbao.Payout.Stake, bad, 0, "");

        hb.claim(id, r, Hongbao.Payout.Stake, sig, 0, "");
        vm.expectRevert(Hongbao.AlreadyClaimed.selector);
        hb.claim(id, r, Hongbao.Payout.Stake, sig, 0, "");

        vm.expectRevert(Hongbao.ZeroAddress.selector);
        hb.claim(id, address(0), Hongbao.Payout.Stake, sig, 0, "");

        _claim(id, makeAddr("r2"), Hongbao.Payout.Save);
        bytes memory sig3 = _sig(keyPk, hb.claimDigest(id, makeAddr("r3"), Hongbao.Payout.Save));
        vm.expectRevert(Hongbao.PacketClosed.selector);
        hb.claim(id, makeAddr("r3"), Hongbao.Payout.Save, sig3, 0, "");
    }

    function test_claimAfterExpiryReverts() public {
        uint256 id = _create(20e18, 2);
        address r = makeAddr("r");
        bytes memory sig = _sig(keyPk, hb.claimDigest(id, r, Hongbao.Payout.Stake));
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(Hongbao.Expired.selector);
        hb.claim(id, r, Hongbao.Payout.Stake, sig, 0, "");
    }

    function test_attesterRequired() public {
        Hongbao.CreateParams memory p = _params(2);
        p.attester = attester;
        vm.prank(alice);
        uint256 id = hb.create{value: 2 * uint256(DRIP + TIP)}(20e18, p);
        address r = makeAddr("r");
        bytes memory sig = _sig(keyPk, hb.claimDigest(id, r, Hongbao.Payout.Stake));

        vm.expectRevert(); // empty attestation
        hb.claim(id, r, Hongbao.Payout.Stake, sig, block.timestamp + 60, "");

        uint256 dl = block.timestamp + 60;
        bytes memory wrongAtt = _sig(keyPk, hb.attestDigest(id, r, dl));
        vm.expectRevert(Hongbao.BadSignature.selector);
        hb.claim(id, r, Hongbao.Payout.Stake, sig, dl, wrongAtt);

        bytes memory att = _sig(attesterPk, hb.attestDigest(id, r, dl));
        // attestation for r cannot be reused for another recipient
        bytes memory sigOther = _sig(keyPk, hb.claimDigest(id, makeAddr("o"), Hongbao.Payout.Stake));
        vm.expectRevert(Hongbao.BadSignature.selector);
        hb.claim(id, makeAddr("o"), Hongbao.Payout.Stake, sigOther, dl, att);

        vm.warp(dl + 1);
        vm.expectRevert(Hongbao.AttestationExpired.selector);
        hb.claim(id, r, Hongbao.Payout.Stake, sig, dl, att);

        vm.warp(dl - 30);
        hb.claim(id, r, Hongbao.Payout.Stake, sig, dl, att);
        assertEq(gauge.balanceOf(r), 9.9e18);
    }

    function test_deadGaugeFallsBackToSavings() public {
        uint256 id = _create(20e18, 2);
        voter.setAlive(address(gauge), false);
        address r = makeAddr("r");
        (, Hongbao.Payout paid) = _claim(id, r, Hongbao.Payout.Stake);
        assertEq(uint8(paid), uint8(Hongbao.Payout.Save));
        assertEq(smusd.balanceOf(r), 9.9e18);

        voter.setAlive(address(gauge), true);
        gauge.setBroken(true);
        address r2 = makeAddr("r2");
        (, paid) = _claim(id, r2, Hongbao.Payout.Stake);
        assertEq(uint8(paid), uint8(Hongbao.Payout.Save));
        assertEq(smusd.balanceOf(r2), 9.9e18);
        assertEq(smusd.allowance(address(hb), address(gauge)), 0, "allowance reset on failure");
    }

    function test_cashFallsBackWhenVaultRefuses() public {
        uint256 id = _create(20e18, 2);
        smusd.setWithdrawBroken(true);
        address r = makeAddr("r");
        (, Hongbao.Payout paid) = _claim(id, r, Hongbao.Payout.Cash);
        assertEq(uint8(paid), uint8(Hongbao.Payout.Save));
        assertEq(smusd.balanceOf(r), 9.9e18);
    }

    function test_contractRecipientGetsBTCByPull() public {
        uint256 id = _create(20e18, 2);
        RevertingReceiver rr = new RevertingReceiver();
        _claim(id, address(rr), Hongbao.Payout.Save);
        assertEq(hb.pendingBTC(address(rr)), DRIP);
        assertEq(smusd.balanceOf(address(rr)), 9.9e18);

        vm.prank(address(rr));
        vm.expectRevert(Hongbao.BTCTransferFailed.selector);
        hb.withdrawBTC();

        vm.prank(makeAddr("nobody"));
        vm.expectRevert(Hongbao.NothingToWithdraw.selector);
        hb.withdrawBTC();
    }

    // ------------------------------------------------------------------ refund

    function test_senderCanRefundEarly() public {
        uint256 id = _create(20e18, 4); // net 19.8
        _claim(id, makeAddr("r"), Hongbao.Payout.Save);
        uint256 musdBefore = musd.balanceOf(alice);
        uint256 btcBefore = alice.balance;
        vm.prank(alice);
        hb.refund(id);
        assertEq(musd.balanceOf(alice) - musdBefore, 14.85e18);
        assertEq(alice.balance - btcBefore, 3 * uint256(DRIP + TIP));
        assertEq(hb.outstanding(), 0);
        assertEq(address(hb).balance, 0);
        vm.prank(alice);
        vm.expectRevert(Hongbao.PacketClosed.selector);
        hb.refund(id);
    }

    function test_othersRefundOnlyAfterExpiry() public {
        uint256 id = _create(20e18, 2);
        vm.prank(relayer);
        vm.expectRevert(Hongbao.NotRefundable.selector);
        hb.refund(id);
        vm.warp(block.timestamp + 1 days);
        uint256 before = musd.balanceOf(alice);
        vm.prank(relayer);
        hb.refund(id);
        assertEq(musd.balanceOf(alice) - before, 19.8e18, "funds go to the sender, not the caller");
        assertEq(musd.balanceOf(relayer), 0);
    }

    function test_refundInKindWhenVaultRefuses() public {
        uint256 id = _create(20e18, 2);
        smusd.setWithdrawBroken(true);
        vm.prank(alice);
        hb.refund(id);
        assertEq(smusd.balanceOf(alice), 19.8e18);
    }

    // ------------------------------------------------------------------ yield

    function test_sweepYieldTakesOnlyYield() public {
        uint256 id = _create(40e18, 4); // net 39.6 held
        musd.mint(address(this), 10e18);
        musd.approve(address(smusd), 10e18);
        smusd.addYield(10e18); // hb is the only holder -> all yield is hb's

        // A cash claim withdraws principal + all pending yield into hb in one go.
        (uint256 a,) = _claim(id, makeAddr("r"), Hongbao.Payout.Cash);
        assertEq(musd.balanceOf(makeAddr("r")), a, "recipient gets exactly the share");
        uint256 swept = hb.sweepYield();
        assertApproxEqAbs(swept, 10e18, 1e6);
        assertEq(musd.balanceOf(address(hb)), 0);
        assertEq(smusd.balanceOf(address(hb)), hb.outstanding(), "principal untouched");

        // remaining shares are still fully backed
        for (uint256 i; i < 3; i++) {
            _claim(id, makeAddr(string(abi.encode("z", i))), Hongbao.Payout.Cash);
        }
        assertEq(hb.outstanding(), 0);
    }

    // ------------------------------------------------------------------ BTC funding

    function test_createWithBTC() public {
        Hongbao.CreateParams memory p = _params(5);
        uint256 btcIn = 0.0003 ether; // ~22.2 MUSD at 74k, pool pays 99.5%
        uint256 kits = 5 * uint256(DRIP + TIP);
        uint256 hbBefore = address(hb).balance;
        vm.prank(alice);
        uint256 id = hb.createWithBTC{value: btcIn + kits}(btcIn, 0, 100, p);
        uint256 expectedOut = btcIn * 74_000e18 / 1e18 * 9950 / 10_000;
        uint256 fee = expectedOut / 100;
        assertEq(hb.getPacket(id).remaining, expectedOut - fee);
        assertEq(address(hb).balance - hbBefore, kits, "only the gas kits stay as native BTC");
        assertEq(btc.allowance(address(hb), address(router)), 0, "approval reset");
    }

    function test_createWithBTCRespectsOracle() public {
        Hongbao.CreateParams memory p = _params(5);
        uint256 btcIn = 0.0003 ether;
        uint256 kits = 5 * uint256(DRIP + TIP);

        vm.startPrank(alice);
        vm.expectRevert(Hongbao.SlippageTooHigh.selector);
        hb.createWithBTC{value: btcIn + kits}(btcIn, 0, 301, p);
        vm.stopPrank();

        // pool pays 3% under the oracle; a 1% bound must refuse
        router.setRate(74_000e18, 9700);
        vm.prank(alice);
        vm.expectRevert();
        hb.createWithBTC{value: btcIn + kits}(btcIn, 0, 100, p);

        // stale oracle refuses outright
        // (MockBTC moves balances with vm.deal, which a revert does not undo; top alice up)
        vm.deal(alice, 1 ether);
        router.setRate(74_000e18, 9950);
        feed.set(74_000e18, true);
        vm.prank(alice);
        vm.expectRevert(bytes("PriceFeed: Oracle is stale."));
        hb.createWithBTC{value: btcIn + kits}(btcIn, 0, 100, p);
    }

    function test_btcSwapCannotTouchOtherKits() public {
        uint256 id = _create(20e18, 10); // 10 kits sit in hb's native balance
        uint256 kitsHeld = address(hb).balance;
        Hongbao.CreateParams memory p = _params(2);
        uint256 btcIn = 0.0003 ether;
        vm.prank(alice);
        hb.createWithBTC{value: btcIn + 2 * uint256(DRIP + TIP)}(btcIn, 0, 100, p);
        assertEq(address(hb).balance, kitsHeld + 2 * uint256(DRIP + TIP));
        // all ten earlier claims still pay their gas
        for (uint256 i; i < 10; i++) {
            _claim(id, makeAddr(string(abi.encode("k", i))), Hongbao.Payout.Save);
        }
        assertEq(address(hb).balance, 2 * uint256(DRIP + TIP));
    }

    // ------------------------------------------------------------------ guardian

    function test_guardian() public {
        vm.expectRevert(Hongbao.NotGuardian.selector);
        hb.setCreationPaused(true);

        vm.prank(guardian);
        hb.setCreationPaused(true);
        Hongbao.CreateParams memory p = _params(2);
        vm.prank(alice);
        vm.expectRevert(Hongbao.Paused.selector);
        hb.create{value: 2 * uint256(DRIP + TIP)}(20e18, p);

        vm.startPrank(guardian);
        hb.setCreationPaused(false);
        vm.expectRevert(Hongbao.CapAboveHardCap.selector);
        hb.setCaps(51e18, 500e18);
        hb.setCaps(10e18, 100e18);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(Hongbao.OverPacketCap.selector);
        hb.create{value: 2 * uint256(DRIP + TIP)}(20e18, p);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_conservation(uint96 amountSeed, uint8 sharesSeed, uint8 claimsSeed, uint8 modeSeed) public {
        uint32 shares = uint32(bound(sharesSeed, 1, 50));
        uint256 amount = bound(amountSeed, uint256(shares) * 0.02e18, 50e18);
        uint256 claims = bound(claimsSeed, 0, shares);
        uint256 id = _create(amount, shares);
        uint256 net = hb.getPacket(id).remaining;

        uint256 paidOut;
        for (uint256 i; i < claims; i++) {
            Hongbao.Payout mode = Hongbao.Payout(uint8((uint256(modeSeed) + i) % 3));
            (uint256 a,) = _claim(id, makeAddr(string(abi.encode("f", i))), mode);
            paidOut += a;
            assertGe(smusd.balanceOf(address(hb)), hb.outstanding(), "backing");
        }
        uint256 before = musd.balanceOf(alice);
        vm.prank(alice);
        hb.refund(id);
        uint256 refunded = musd.balanceOf(alice) - before;
        assertEq(paidOut + refunded, net, "every MUSD is paid or refunded");
        assertEq(hb.outstanding(), 0);
        assertEq(address(hb).balance, 0, "every gas kit is spent or returned");
    }
}
