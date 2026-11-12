// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IMUSDSavingsRate, IVaultGauge, IVoter, IPriceFeed, IRouter} from "./interfaces/IMezo.sol";

/// @title Hongbao (紅包): MUSD red packets that land in Mezo savings
/// @notice A sender funds a packet with MUSD (or BTC, swapped to MUSD on Mezo's
///         own pool). While unclaimed, the MUSD sits in Mezo's MUSD Savings Rate
///         vault as sMUSD. Anyone holding the packet link can claim one equal
///         share to their address; the share is staked in Mezo's sMUSD gauge in
///         the recipient's own name (earning MEZO), kept as sMUSD, or paid out as
///         MUSD. Each share also carries a small BTC gas drip so a brand-new
///         wallet can act on Mezo, and a tip that pays whoever relays the claim.
/// @dev No owner can touch funds. A guardian can only pause new packets and
///      lower deposit caps below immutable hard caps. Packets are refundable by
///      their sender at any time and by anyone (to the sender) after expiry.
contract Hongbao is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    enum Payout {
        Stake, // sMUSD staked in the vault gauge for the recipient (earns MEZO)
        Save, // sMUSD transferred to the recipient (earns MUSD savings yield)
        Cash // MUSD transferred to the recipient
    }

    enum Funding {
        MUSD,
        BTC
    }

    struct Packet {
        address sender;
        uint64 expiry;
        uint32 sharesTotal;
        address claimKey;
        uint32 sharesLeft;
        bool refunded;
        address attester;
        uint96 dripPerShare; // BTC (wei) sent to each recipient
        uint128 remaining; // sMUSD still held for this packet
        uint96 tipPerShare; // BTC (wei) paid to whoever relays each claim
    }

    struct CreateParams {
        uint32 shares;
        uint64 expiry; // absolute unix time
        address claimKey; // public address of the one-time key carried in the link
        address attester; // optional co-signer (0 = none)
        uint96 dripPerShare;
        uint96 tipPerShare;
        string message;
    }

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    uint256 public constant MAX_SHARES = 100;
    uint256 public constant MIN_SHARE = 0.01e18; // 0.01 MUSD
    uint256 public constant MIN_DURATION = 10 minutes;
    uint256 public constant MAX_DURATION = 7 days;
    uint256 public constant MAX_DRIP = 0.00002 ether; // 0.00002 BTC
    uint256 public constant MAX_TIP = 0.000005 ether; // 0.000005 BTC
    uint256 public constant MAX_SLIPPAGE_BPS = 300;
    uint256 public constant MAX_MESSAGE_BYTES = 200;
    uint256 public constant BTC_SEND_GAS = 50_000;

    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("Claim(uint256 packetId,address recipient,uint8 payout,address relayer)");
    bytes32 public constant ATTEST_TYPEHASH =
        keccak256("Attest(uint256 packetId,address recipient,uint8 payout,uint256 deadline)");

    // ------------------------------------------------------------------
    // Immutable wiring
    // ------------------------------------------------------------------

    IERC20 public immutable musd;
    IMUSDSavingsRate public immutable smusd;
    IVaultGauge public immutable gauge;
    IPriceFeed public immutable priceFeed;
    IRouter public immutable router;
    address public immutable btc; // ERC-20 view of native BTC on Mezo
    address public immutable poolFactory;
    address public immutable treasury;
    uint256 public immutable feeBps;
    uint256 public immutable hardMaxPerPacket;
    uint256 public immutable hardMaxPerSender;
    uint256 public immutable hardMaxOutstanding;

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    address public guardian;
    address public pendingGuardian;
    bool public creationPaused;
    uint256 public maxPerPacket;
    uint256 public maxPerSender;
    uint256 public maxOutstanding;
    uint256 public outstanding; // sMUSD held for open packets
    mapping(address => uint256) public senderOutstanding;

    uint256 public packetCount;
    uint256 public totalClaims;
    uint256 public totalVolume; // net MUSD put into packets
    uint256 public uniqueRecipients;
    uint256 public uniqueSenders;

    mapping(uint256 => Packet) internal _packets;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(address => bool) public seenRecipient;
    mapping(address => bool) public seenSender;
    mapping(address => uint256) public pendingBTC;

    // ------------------------------------------------------------------
    // Events and errors
    // ------------------------------------------------------------------

    event PacketCreated(
        uint256 indexed id,
        address indexed sender,
        uint256 net,
        uint256 fee,
        uint32 shares,
        uint64 expiry,
        Funding funding,
        address claimKey,
        address attester,
        string message
    );
    event Claimed(
        uint256 indexed id, address indexed recipient, address indexed relayer, uint256 amount, Payout payout
    );
    event Refunded(uint256 indexed id, address indexed to, uint256 amount, uint256 btcReturned, bool inKind);
    event YieldSwept(uint256 amount);
    event BTCDeferred(address indexed to, uint256 amount);
    event BTCWithdrawn(address indexed to, uint256 amount);
    event GuardianProposed(address indexed guardian);
    event GuardianChanged(address indexed guardian);
    event CreationPaused(bool paused);
    event CapsChanged(uint256 maxPerPacket, uint256 maxPerSender, uint256 maxOutstanding);

    error NotGuardian();
    error Paused();
    error BadShares();
    error BadExpiry();
    error BadKey();
    error BadGasKit();
    error MessageTooLong();
    error ShareTooSmall();
    error OverPacketCap();
    error OverOutstandingCap();
    error OverSenderCap();
    error BadRecipient();
    error WrongRelayer();
    error NotPendingGuardian();
    error BadValue();
    error UnknownPacket();
    error PacketClosed();
    error Expired();
    error AlreadyClaimed();
    error ZeroAddress();
    error BadSignature();
    error AttestationExpired();
    error NotRefundable();
    error SlippageTooHigh();
    error InsufficientOutput();
    error NothingToWithdraw();
    error BTCTransferFailed();
    error CapAboveHardCap();
    error OracleUnavailable();

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    struct Wiring {
        address musd;
        address smusd;
        address gauge;
        address priceFeed;
        address router;
        address btc;
        address poolFactory;
        address treasury;
        address guardian;
        uint256 feeBps;
        uint256 maxPerPacket;
        uint256 maxPerSender;
        uint256 maxOutstanding;
        uint256 hardMaxPerPacket;
        uint256 hardMaxPerSender;
        uint256 hardMaxOutstanding;
    }

    constructor(Wiring memory w) EIP712("Hongbao", "1") {
        if (
            w.musd == address(0) || w.smusd == address(0) || w.gauge == address(0) || w.priceFeed == address(0)
                || w.router == address(0) || w.btc == address(0) || w.poolFactory == address(0)
                || w.treasury == address(0) || w.guardian == address(0)
        ) revert ZeroAddress();
        require(w.feeBps <= 200, "fee too high");
        require(IVaultGauge(w.gauge).stakingToken() == w.smusd, "gauge/sMUSD mismatch");

        musd = IERC20(w.musd);
        smusd = IMUSDSavingsRate(w.smusd);
        gauge = IVaultGauge(w.gauge);
        priceFeed = IPriceFeed(w.priceFeed);
        router = IRouter(w.router);
        btc = w.btc;
        poolFactory = w.poolFactory;
        treasury = w.treasury;
        feeBps = w.feeBps;
        if (
            w.maxPerPacket > w.hardMaxPerPacket || w.maxPerSender > w.hardMaxPerSender
                || w.maxOutstanding > w.hardMaxOutstanding
        ) revert CapAboveHardCap();
        hardMaxPerPacket = w.hardMaxPerPacket;
        hardMaxPerSender = w.hardMaxPerSender;
        hardMaxOutstanding = w.hardMaxOutstanding;
        maxPerPacket = w.maxPerPacket;
        maxPerSender = w.maxPerSender;
        maxOutstanding = w.maxOutstanding;
        guardian = w.guardian;
        emit GuardianChanged(w.guardian);
        emit CapsChanged(w.maxPerPacket, w.maxPerSender, w.maxOutstanding);
    }

    // ------------------------------------------------------------------
    // Create
    // ------------------------------------------------------------------

    /// @notice Create a packet from MUSD the caller has approved.
    function create(uint256 amount, CreateParams calldata p) external payable nonReentrant returns (uint256 id) {
        _checkGasKit(p, msg.value);
        musd.safeTransferFrom(msg.sender, address(this), amount);
        id = _open(amount, p, Funding.MUSD);
    }

    /// @notice Create a packet from MUSD using an EIP-2612 permit (no separate approve).
    /// @dev The permit call is wrapped so a front-run permit cannot block creation.
    function createWithPermit(uint256 amount, CreateParams calldata p, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        _checkGasKit(p, msg.value);
        try IERC20Permit(address(musd)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        musd.safeTransferFrom(msg.sender, address(this), amount);
        id = _open(amount, p, Funding.MUSD);
    }

    /// @notice Create a packet from native BTC. `btcIn` is swapped to MUSD on Mezo's
    ///         BTC/MUSD pool; the output must clear both `minMusdOut` and the MUSD
    ///         PriceFeed value less `maxSlippageBps`. msg.value = btcIn + gas kits.
    function createWithBTC(uint256 btcIn, uint256 minMusdOut, uint256 maxSlippageBps, CreateParams calldata p)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        if (btcIn == 0 || msg.value < btcIn) revert BadValue();
        _checkGasKit(p, msg.value - btcIn);

        uint256 price;
        try priceFeed.fetchPrice() returns (uint256 pr) {
            price = pr;
        } catch {
            revert OracleUnavailable(); // stale (>60 s) or unavailable
        }
        uint256 oracleMin = (btcIn * price / 1e18) * (10_000 - maxSlippageBps) / 10_000;
        uint256 floor = oracleMin > minMusdOut ? oracleMin : minMusdOut;

        IRouter.Route[] memory routes = new IRouter.Route[](1);
        routes[0] = IRouter.Route({from: btc, to: address(musd), stable: false, factory: poolFactory});

        uint256 before = musd.balanceOf(address(this));
        // Approve exactly btcIn: the contract's native balance also holds other packets' gas kits.
        IERC20(btc).forceApprove(address(router), btcIn);
        router.swapExactTokensForTokens(btcIn, floor, routes, address(this), block.timestamp);
        IERC20(btc).forceApprove(address(router), 0);
        uint256 out = musd.balanceOf(address(this)) - before;
        if (out < floor) revert InsufficientOutput();

        id = _open(out, p, Funding.BTC);
    }

    function _checkGasKit(CreateParams calldata p, uint256 value) internal pure {
        if (p.dripPerShare > MAX_DRIP || p.tipPerShare > MAX_TIP) revert BadGasKit();
        if (value != uint256(p.shares) * (uint256(p.dripPerShare) + uint256(p.tipPerShare))) revert BadValue();
    }

    function _open(uint256 gross, CreateParams calldata p, Funding funding) internal returns (uint256 id) {
        if (creationPaused) revert Paused();
        if (p.shares == 0 || p.shares > MAX_SHARES) revert BadShares();
        if (p.expiry < block.timestamp + MIN_DURATION || p.expiry > block.timestamp + MAX_DURATION) revert BadExpiry();
        if (p.claimKey == address(0)) revert BadKey();
        if (bytes(p.message).length > MAX_MESSAGE_BYTES) revert MessageTooLong();

        uint256 fee = gross * feeBps / 10_000;
        uint256 net = gross - fee;
        if (net / p.shares < MIN_SHARE) revert ShareTooSmall();
        if (net > maxPerPacket) revert OverPacketCap();
        if (outstanding + net > maxOutstanding) revert OverOutstandingCap();
        if (senderOutstanding[msg.sender] + net > maxPerSender) revert OverSenderCap();

        if (fee > 0) musd.safeTransfer(treasury, fee);
        musd.forceApprove(address(smusd), net);
        smusd.deposit(net); // mints sMUSD 1:1 to this contract

        id = ++packetCount;
        _packets[id] = Packet({
            sender: msg.sender,
            expiry: p.expiry,
            sharesTotal: p.shares,
            claimKey: p.claimKey,
            sharesLeft: p.shares,
            refunded: false,
            attester: p.attester,
            dripPerShare: p.dripPerShare,
            remaining: uint128(net),
            tipPerShare: p.tipPerShare
        });
        outstanding += net;
        senderOutstanding[msg.sender] += net;
        totalVolume += net;
        if (!seenSender[msg.sender]) {
            seenSender[msg.sender] = true;
            uniqueSenders++;
        }

        emit PacketCreated(
            id, msg.sender, net, fee, p.shares, p.expiry, funding, p.claimKey, p.attester, p.message
        );
    }

    // ------------------------------------------------------------------
    // Claim
    // ------------------------------------------------------------------

    /// @notice Claim one share of packet `id` for `recipient`. Anyone may submit;
    ///         the caller receives the packet's relay tip.
    /// @param relayer The only address allowed to submit this claim (0 = anyone). Signed, so a
    ///        copied transaction cannot steal the relay tip.
    /// @param keySig EIP-712 Claim(id, recipient, payout, relayer) signed by the link key.
    /// @param attestDeadline Deadline of the attester's signature (ignored without an attester).
    /// @param attestSig EIP-712 Attest(id, recipient, payout, deadline) signed by the packet's attester, if any.
    function claim(
        uint256 id,
        address recipient,
        Payout payout,
        address relayer,
        bytes calldata keySig,
        uint256 attestDeadline,
        bytes calldata attestSig
    ) external nonReentrant returns (uint256 amount, Payout paid) {
        Packet storage pk = _packets[id];
        if (pk.sender == address(0)) revert UnknownPacket();
        if (pk.refunded || pk.sharesLeft == 0) revert PacketClosed();
        if (block.timestamp >= pk.expiry) revert Expired();
        if (recipient == address(0)) revert ZeroAddress();
        if (
            recipient == address(this) || recipient == address(smusd) || recipient == address(gauge)
                || recipient == address(musd) || recipient == btc
        ) revert BadRecipient();
        if (relayer != address(0) && msg.sender != relayer) revert WrongRelayer();
        if (claimed[id][recipient]) revert AlreadyClaimed();

        _requireSigner(
            pk.claimKey, keccak256(abi.encode(CLAIM_TYPEHASH, id, recipient, uint8(payout), relayer)), keySig
        );
        if (pk.attester != address(0)) {
            if (block.timestamp > attestDeadline) revert AttestationExpired();
            _requireSigner(
                pk.attester, keccak256(abi.encode(ATTEST_TYPEHASH, id, recipient, uint8(payout), attestDeadline)), attestSig
            );
        }

        // Effects
        claimed[id][recipient] = true;
        amount = pk.sharesLeft == 1 ? pk.remaining : pk.remaining / pk.sharesLeft;
        pk.remaining -= uint128(amount);
        pk.sharesLeft -= 1;
        outstanding -= amount;
        senderOutstanding[pk.sender] -= amount;
        totalClaims++;
        if (!seenRecipient[recipient]) {
            seenRecipient[recipient] = true;
            uniqueRecipients++;
        }
        uint256 drip = pk.dripPerShare;
        uint256 tip = pk.tipPerShare;

        // Interactions with Mezo contracts
        paid = _payout(recipient, amount, payout);

        emit Claimed(id, recipient, msg.sender, amount, paid);

        // Native BTC last
        _sendBTC(recipient, drip);
        _sendBTC(msg.sender, tip);
    }

    function _payout(address recipient, uint256 amount, Payout payout) internal returns (Payout) {
        if (payout == Payout.Stake) {
            if (_gaugeAlive()) {
                IERC20(address(smusd)).forceApprove(address(gauge), amount);
                try gauge.deposit(amount, recipient) {
                    return Payout.Stake;
                } catch {
                    IERC20(address(smusd)).forceApprove(address(gauge), 0);
                }
            }
            IERC20(address(smusd)).safeTransfer(recipient, amount);
            return Payout.Save;
        }
        if (payout == Payout.Cash) {
            try smusd.withdraw(amount) {
                musd.safeTransfer(recipient, amount);
                return Payout.Cash;
            } catch {
                IERC20(address(smusd)).safeTransfer(recipient, amount);
                return Payout.Save;
            }
        }
        IERC20(address(smusd)).safeTransfer(recipient, amount);
        return Payout.Save;
    }

    function _requireSigner(address expected, bytes32 structHash, bytes calldata sig) internal view {
        (address got, ECDSA.RecoverError err,) = ECDSA.tryRecover(_hashTypedDataV4(structHash), sig);
        if (err != ECDSA.RecoverError.NoError || got != expected) revert BadSignature();
    }

    function _gaugeAlive() internal view returns (bool) {
        try gauge.voter() returns (address v) {
            try IVoter(v).isAlive(address(gauge)) returns (bool alive) {
                return alive;
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // Refund
    // ------------------------------------------------------------------

    /// @notice Close a packet and return what is left (MUSD, or sMUSD in kind if the
    ///         vault refuses a withdrawal) plus unused gas kits to its sender. The
    ///         sender may do this at any time; anyone may do it after expiry.
    function refund(uint256 id) external nonReentrant {
        Packet storage pk = _packets[id];
        if (pk.sender == address(0)) revert UnknownPacket();
        if (pk.refunded) revert PacketClosed();
        if (msg.sender != pk.sender && block.timestamp < pk.expiry) revert NotRefundable();

        address to = pk.sender;
        uint256 amount = pk.remaining;
        uint256 kits = uint256(pk.sharesLeft) * (uint256(pk.dripPerShare) + uint256(pk.tipPerShare));
        pk.refunded = true;
        pk.remaining = 0;
        pk.sharesLeft = 0;
        outstanding -= amount;
        senderOutstanding[to] -= amount;

        bool inKind;
        if (amount > 0) {
            try smusd.withdraw(amount) {
                musd.safeTransfer(to, amount);
            } catch {
                inKind = true;
                IERC20(address(smusd)).safeTransfer(to, amount);
            }
        }
        emit Refunded(id, to, amount, kits, inKind);
        _sendBTC(to, kits);
    }

    // ------------------------------------------------------------------
    // Yield and BTC housekeeping
    // ------------------------------------------------------------------

    /// @notice Send the savings yield earned on unclaimed packets to the treasury.
    /// @dev Between transactions this contract only ever holds MUSD that is yield:
    ///      packet principal is always held as sMUSD.
    function sweepYield() external nonReentrant returns (uint256 amount) {
        try smusd.claimYield() {} catch {}
        amount = musd.balanceOf(address(this));
        if (amount > 0) {
            musd.safeTransfer(treasury, amount);
            emit YieldSwept(amount);
        }
    }

    /// @notice Withdraw BTC that could not be pushed to you (e.g. a contract recipient).
    function withdrawBTC() external nonReentrant {
        uint256 amount = pendingBTC[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingBTC[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert BTCTransferFailed();
        emit BTCWithdrawn(msg.sender, amount);
    }

    function _sendBTC(address to, uint256 amount) internal {
        if (amount == 0) return;
        bool ok;
        // Do not copy return data: a recipient cannot make the relayer pay for a return bomb.
        assembly {
            ok := call(BTC_SEND_GAS, to, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            pendingBTC[to] += amount;
            emit BTCDeferred(to, amount);
        }
    }

    // ------------------------------------------------------------------
    // Guardian (cannot move funds)
    // ------------------------------------------------------------------

    function setCreationPaused(bool paused) external onlyGuardian {
        creationPaused = paused;
        emit CreationPaused(paused);
    }

    /// @notice Set caps, never above the hard caps fixed at deployment.
    function setCaps(uint256 perPacket, uint256 perSender, uint256 total) external onlyGuardian {
        if (perPacket > hardMaxPerPacket || perSender > hardMaxPerSender || total > hardMaxOutstanding) {
            revert CapAboveHardCap();
        }
        maxPerPacket = perPacket;
        maxPerSender = perSender;
        maxOutstanding = total;
        emit CapsChanged(perPacket, perSender, total);
    }

    /// @notice Two-step handover: the proposed guardian must accept.
    function proposeGuardian(address next) external onlyGuardian {
        if (next == address(0)) revert ZeroAddress();
        pendingGuardian = next;
        emit GuardianProposed(next);
    }

    function acceptGuardian() external {
        if (msg.sender != pendingGuardian) revert NotPendingGuardian();
        guardian = msg.sender;
        pendingGuardian = address(0);
        emit GuardianChanged(msg.sender);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getPacket(uint256 id) external view returns (Packet memory) {
        return _packets[id];
    }

    /// @notice Amount the next claim of packet `id` would receive.
    function nextShare(uint256 id) external view returns (uint256) {
        Packet storage pk = _packets[id];
        if (pk.refunded || pk.sharesLeft == 0 || block.timestamp >= pk.expiry) return 0;
        return pk.sharesLeft == 1 ? pk.remaining : pk.remaining / pk.sharesLeft;
    }

    function stats()
        external
        view
        returns (
            uint256 packets,
            uint256 claims,
            uint256 volume,
            uint256 recipients,
            uint256 senders,
            uint256 open
        )
    {
        return (packetCount, totalClaims, totalVolume, uniqueRecipients, uniqueSenders, outstanding);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Typed-data digest the link key must sign for a claim.
    function claimDigest(uint256 id, address recipient, Payout payout, address relayer)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, id, recipient, uint8(payout), relayer)));
    }

    /// @notice Typed-data digest the attester must sign for a claim.
    function attestDigest(uint256 id, address recipient, Payout payout, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(ATTEST_TYPEHASH, id, recipient, uint8(payout), deadline)));
    }
}
