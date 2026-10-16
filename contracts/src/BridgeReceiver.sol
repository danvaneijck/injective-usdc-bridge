// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool);
}

/// @title BridgeReceiver
/// @notice Injective-side wrapper for CCTP V2 deposits that want a gas drop
/// (and, later, a bridge fee). Such a burn sets `mintRecipient` and
/// `destinationCaller` to this contract and carries our hook data. Anyone may
/// then call {relay} with Circle's attestation: it mints, pays the user, and
/// sends a small INJ drop from the float in one transaction.
///
/// MessageTransmitterV2 never calls back into a mintRecipient, so the hook has
/// to run in a wrapper around receiveMessage (Circle's CCTPHookWrapper shape).
///
/// Invariants, each from a v1 incident:
///  - {relay} is permissionless and cannot be paused. Pausing stops drops,
///    never delivery, so a burn pinned to this contract can always complete.
///  - Once a message is ours, {relay} never reverts on economics. A drop that
///    cannot be honoured (fee would eat the amount, float empty, paused, the
///    user's max fee exceeded, recipient refuses INJ) is skipped and its fee
///    is not charged. v1 reverted instead and locked 3 transfers forever.
///  - USDC that cannot be delivered (blacklist) or whose hook is malformed is
///    escrowed for its owner, never swept as fees.
contract BridgeReceiver is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Message layout (MessageV2 header + BurnMessageV2 body)
    // ---------------------------------------------------------------------

    uint256 internal constant HEADER = 148;
    uint256 internal constant NONCE = 12;
    uint256 internal constant MINT_RECIPIENT = HEADER + 36;
    uint256 internal constant MESSAGE_SENDER = HEADER + 100;
    uint256 internal constant HOOK = HEADER + 228;

    /// @notice Hook data = abi.encode(bytes4 HOOK_MAGIC, address recipient, uint256 maxDropFee).
    /// `maxDropFee == 0` means no drop wanted; the deposit is only routed
    /// through this contract (for a future bridge fee).
    bytes4 public constant HOOK_MAGIC = 0x49554231; // "IUB1"
    uint256 internal constant HOOK_LEN = 96;

    /// @notice Hard ceiling on the bridge fee, so no owner can ever set more.
    uint256 public constant MAX_FEE_BPS = 50;

    uint256 internal constant DROP_GAS = 50_000;

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    IERC20 public immutable usdc;
    /// @notice Ceilings fixed at deploy so a compromised owner or pricer key
    /// cannot set a drop that drains the float in one burn or charge users
    /// an arbitrary fee.
    uint256 public immutable maxDropWei;
    uint256 public immutable maxDropFee;

    IMessageTransmitterV2 public messageTransmitter;

    /// @notice INJ sent per drop, in wei. 0 disables drops.
    uint256 public dropWei;
    /// @notice USDC charged per drop, in base units. Kept near cost by the pricer.
    uint256 public dropFee;
    /// @notice Owner-set floor under {dropFee}, so a pricer key cannot make
    /// drops cheap enough to farm.
    uint256 public minDropFee;
    bool public dropsPaused;

    /// @notice Bridge fee on every relayed deposit, in bps. 0 today.
    uint256 public feeBps;

    /// @notice May set {dropFee} within [minDropFee, maxDropFee] and pause drops.
    address public pricer;
    /// @notice May sweep accrued fees, only to itself (the refill keeper).
    address public sweeper;

    // ---------------------------------------------------------------------
    // Accounting
    // ---------------------------------------------------------------------

    /// @notice Fees earned and not yet swept (drop fees + bridge fees).
    uint256 public accruedFees;
    /// @notice USDC held for owners who could not be paid inline.
    uint256 public totalEscrow;
    /// @notice Escrow by bytes32 account: an EVM address left-padded, or a
    /// non-EVM burn sender (e.g. a Solana key) when the hook was malformed.
    mapping(bytes32 => uint256) public escrow;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Relayed(
        bytes32 indexed nonce,
        address indexed recipient,
        uint256 minted,
        uint256 usdcPaid,
        uint256 dropFeeCharged,
        uint256 injDropped,
        uint256 bridgeFeeCharged
    );
    /// @dev reason: 1 paused, 2 drops disabled, 3 fee above user's max,
    /// 4 float too low, 5 amount too small, 6 recipient refused INJ.
    event DropSkipped(bytes32 indexed nonce, address indexed recipient, uint8 reason);
    event PassedThrough(bytes32 indexed nonce);
    event RelayNoMint(bytes32 indexed nonce);
    event HookInvalid(bytes32 indexed nonce, bytes32 indexed sender, uint256 amount);
    event Escrowed(bytes32 indexed account, uint256 amount);
    event EscrowClaimed(bytes32 indexed account, address indexed to, uint256 amount);
    event EscrowReassigned(bytes32 indexed from, address indexed to, uint256 amount);

    event FloatFunded(address indexed from, uint256 amount);
    event FeesSwept(address indexed to, uint256 amount);
    event InjSwept(address indexed to, uint256 amount);
    event StrayRecovered(address indexed to, uint256 amount);

    event MessageTransmitterSet(address indexed previous, address indexed next);
    event DropConfigSet(uint256 dropWei, uint256 minDropFee);
    event DropFeeSet(uint256 dropFee);
    event DropsPausedSet(bool paused);
    event FeeBpsSet(uint256 feeBps);
    event PricerSet(address indexed pricer);
    event SweeperSet(address indexed sweeper);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ReceiveMessageFailed();
    error ZeroAddress();
    error NotAContract();
    error RenounceDisabled();
    error Unauthorized();
    error AboveCeiling();
    error BelowFloor();
    error SweeperMustSweepToSelf();
    error ExceedsAvailable();
    error EvmEscrowNotReassignable();
    error NothingToClaim();
    error InjTransferFailed();

    constructor(address mt, address usdc_, address owner_, uint256 maxDropWei_, uint256 maxDropFee_)
        Ownable(owner_)
    {
        if (mt == address(0) || usdc_ == address(0)) revert ZeroAddress();
        if (mt.code.length == 0 || usdc_.code.length == 0) revert NotAContract();
        messageTransmitter = IMessageTransmitterV2(mt);
        usdc = IERC20(usdc_);
        maxDropWei = maxDropWei_;
        maxDropFee = maxDropFee_;
    }

    receive() external payable {
        emit FloatFunded(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------------
    // Relay
    // ---------------------------------------------------------------------

    /// @notice Complete a CCTP message pinned to this contract. Permissionless:
    /// Circle's attestation is the authority. Reverts only when the
    /// MessageTransmitter does (bad attestation, nonce already used).
    function relay(bytes calldata message, bytes calldata attestation) external nonReentrant {
        bytes32 nonce = message.length >= NONCE + 32 ? bytes32(message[NONCE:NONCE + 32]) : bytes32(0);

        // A message whose mint does not land here (or is not a burn at all)
        // is still completed, so nothing pinned to us can ever be stranded.
        if (message.length < HOOK || bytes32(message[MINT_RECIPIENT:MINT_RECIPIENT + 32]) != _self()) {
            if (!messageTransmitter.receiveMessage(message, attestation)) revert ReceiveMessageFailed();
            emit PassedThrough(nonce);
            return;
        }

        uint256 before = usdc.balanceOf(address(this));
        if (!messageTransmitter.receiveMessage(message, attestation)) revert ReceiveMessageFailed();
        uint256 minted = usdc.balanceOf(address(this)) - before;
        if (minted == 0) {
            emit RelayNoMint(nonce);
            return;
        }

        (bool valid, address recipient, uint256 userMaxDropFee) = _parseHook(message[HOOK:]);
        if (!valid) {
            bytes32 sender = bytes32(message[MESSAGE_SENDER:MESSAGE_SENDER + 32]);
            _escrow(sender, minted);
            emit HookInvalid(nonce, sender, minted);
            return;
        }
        _settle(nonce, recipient, userMaxDropFee, minted);
    }

    function _settle(bytes32 nonce, address recipient, uint256 userMaxDropFee, uint256 minted) internal {
        // feeBps <= 50, so the bridge fee is always below the minted amount.
        uint256 bridgeFee = (minted * feeBps) / 10_000;
        uint256 fee;
        uint256 drop;

        if (userMaxDropFee != 0) {
            uint8 reason = _dropBlocker(userMaxDropFee, minted, bridgeFee);
            if (reason == 0) {
                fee = dropFee;
                drop = dropWei;
            } else {
                emit DropSkipped(nonce, recipient, reason);
            }
        }

        // Account for every minted unit before the INJ call hands control to
        // the recipient; a refused drop refunds its fee afterwards.
        uint256 paid = minted - fee - bridgeFee;
        accruedFees += fee + bridgeFee;
        _pay(recipient, paid);

        if (drop != 0) {
            (bool sent,) = payable(recipient).call{value: drop, gas: DROP_GAS}("");
            if (!sent) {
                emit DropSkipped(nonce, recipient, 6);
                accruedFees -= fee;
                _pay(recipient, fee);
                paid += fee;
                fee = 0;
                drop = 0;
            }
        }
        emit Relayed(nonce, recipient, minted, paid, fee, drop, bridgeFee);
    }

    function _dropBlocker(uint256 userMaxDropFee, uint256 minted, uint256 bridgeFee)
        internal
        view
        returns (uint8)
    {
        if (dropsPaused) return 1;
        uint256 w = dropWei;
        if (w == 0) return 2;
        uint256 f = dropFee;
        if (f > userMaxDropFee) return 3;
        if (address(this).balance < w) return 4;
        if (minted <= f + bridgeFee) return 5;
        return 0;
    }

    // ---------------------------------------------------------------------
    // Escrow
    // ---------------------------------------------------------------------

    /// @notice Withdraw USDC escrowed for the caller, to any address (so a
    /// blacklisted recipient can still be made whole elsewhere).
    function claim(address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        bytes32 account = bytes32(uint256(uint160(msg.sender)));
        uint256 amount = escrow[account];
        if (amount == 0) revert NothingToClaim();
        escrow[account] = 0;
        totalEscrow -= amount;
        usdc.safeTransfer(to, amount);
        emit EscrowClaimed(account, to, amount);
    }

    /// @notice Move escrow held for a non-EVM sender (malformed hook from,
    /// say, a Solana burn) to the EVM address its owner proves off-chain.
    /// EVM-shaped accounts can claim themselves and are out of reach here.
    function reassignEscrow(bytes32 from, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (uint256(from) >> 160 == 0) revert EvmEscrowNotReassignable();
        uint256 amount = escrow[from];
        if (amount == 0) revert NothingToClaim();
        escrow[from] = 0;
        escrow[bytes32(uint256(uint160(to)))] += amount;
        emit EscrowReassigned(from, to, amount);
    }

    // ---------------------------------------------------------------------
    // Treasury
    // ---------------------------------------------------------------------

    /// @notice Sweep accrued fees. Never touches escrow. The sweeper may only
    /// sweep to itself, so a leaked keeper key drains to a watched wallet.
    function sweepFees(uint256 amount, address to) external nonReentrant {
        if (msg.sender != owner()) {
            if (msg.sender != sweeper) revert Unauthorized();
            if (to != msg.sender) revert SweeperMustSweepToSelf();
        }
        if (to == address(0)) revert ZeroAddress();
        if (amount > accruedFees) revert ExceedsAvailable();
        accruedFees -= amount;
        usdc.safeTransfer(to, amount);
        emit FeesSwept(to, amount);
    }

    function sweepInj(uint256 amount, address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool sent,) = to.call{value: amount}("");
        if (!sent) revert InjTransferFailed();
        emit InjSwept(to, amount);
    }

    /// @notice USDC held here that is neither fees nor escrow, e.g. minted by
    /// a third party calling receiveMessage directly on a burn that left
    /// destinationCaller at zero. The owner pays it out after checking the
    /// burn off-chain.
    function strayBalance() public view returns (uint256) {
        return usdc.balanceOf(address(this)) - accruedFees - totalEscrow;
    }

    function recoverStray(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > strayBalance()) revert ExceedsAvailable();
        usdc.safeTransfer(to, amount);
        emit StrayRecovered(to, amount);
    }

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    function setMessageTransmitter(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        if (next.code.length == 0) revert NotAContract();
        emit MessageTransmitterSet(address(messageTransmitter), next);
        messageTransmitter = IMessageTransmitterV2(next);
    }

    function setDropConfig(uint256 dropWei_, uint256 minDropFee_) external onlyOwner {
        if (dropWei_ > maxDropWei || minDropFee_ > maxDropFee) revert AboveCeiling();
        dropWei = dropWei_;
        minDropFee = minDropFee_;
        if (dropFee < minDropFee_) {
            dropFee = minDropFee_;
            emit DropFeeSet(minDropFee_);
        }
        emit DropConfigSet(dropWei_, minDropFee_);
    }

    function setDropFee(uint256 fee) external {
        if (msg.sender != owner() && msg.sender != pricer) revert Unauthorized();
        if (fee > maxDropFee) revert AboveCeiling();
        if (fee < minDropFee) revert BelowFloor();
        dropFee = fee;
        emit DropFeeSet(fee);
    }

    /// @notice The pricer may pause drops (e.g. float alarm); only the owner unpauses.
    function setDropsPaused(bool paused) external {
        if (msg.sender != owner() && !(msg.sender == pricer && paused)) revert Unauthorized();
        dropsPaused = paused;
        emit DropsPausedSet(paused);
    }

    function setFeeBps(uint256 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert AboveCeiling();
        feeBps = bps;
        emit FeeBpsSet(bps);
    }

    function setPricer(address next) external onlyOwner {
        pricer = next;
        emit PricerSet(next);
    }

    function setSweeper(address next) external onlyOwner {
        sweeper = next;
        emit SweeperSet(next);
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _self() internal view returns (bytes32) {
        return bytes32(uint256(uint160(address(this))));
    }

    /// @dev Never reverts: a malformed hook is reported as invalid so the
    /// caller can escrow the mint instead of stranding it.
    function _parseHook(bytes calldata hook)
        internal
        pure
        returns (bool valid, address recipient, uint256 userMaxDropFee)
    {
        if (hook.length < HOOK_LEN) return (false, address(0), 0);
        if (bytes4(hook[0:4]) != HOOK_MAGIC) return (false, address(0), 0);
        uint256 rawRecipient = uint256(bytes32(hook[32:64]));
        if (rawRecipient >> 160 != 0 || rawRecipient == 0) return (false, address(0), 0);
        // forge-lint: disable-next-line(unsafe-typecast)
        return (true, address(uint160(rawRecipient)), uint256(bytes32(hook[64:96])));
    }

    /// @dev USDC returns false or reverts for blacklisted parties; either way
    /// the amount is escrowed for the recipient instead of bricking the relay.
    function _pay(address recipient, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory ret) =
            address(usdc).call(abi.encodeWithSelector(IERC20.transfer.selector, recipient, amount));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) return;
        _escrow(bytes32(uint256(uint160(recipient))), amount);
    }

    function _escrow(bytes32 account, uint256 amount) internal {
        escrow[account] += amount;
        totalEscrow += amount;
        emit Escrowed(account, amount);
    }
}
