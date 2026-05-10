// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title VerifyingPaymaster
 * @notice ERC-4337 Paymaster supporting:
 *   - Free (dApp-sponsored) gas
 *   - ERC-20 token gas payments (USDC, DAI, etc.)
 *   - Per-user spending caps & global daily limits
 *   - Off-chain signature-based validation
 *
 * EntryPoint v0.7: 0x0000000071727De22E5E9d8BAf0edAc6f37da032
 */

import "@account-abstraction/contracts/interfaces/IPaymaster.sol";
import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import "@account-abstraction/contracts/core/UserOperationLib.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract VerifyingPaymaster is IPaymaster, Ownable, ReentrancyGuard {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;
    using UserOperationLib for PackedUserOperation;

    // ─────────────────────────────────────────────
    //  Constants & Immutables
    // ─────────────────────────────────────────────

    /// @notice ERC-4337 EntryPoint (v0.7)
    IEntryPoint public immutable entryPoint;

    uint256 public constant PAYMASTER_DATA_OFFSET = 20; // (paymaster addr 20 bytes)
    uint256 public constant SIG_VALIDATION_FAILED = 1;
    uint256 public constant SIG_VALIDATION_SUCCESS = 0;

    // ─────────────────────────────────────────────
    //  Payment Modes
    // ─────────────────────────────────────────────

    /// @dev Mode 0 = sponsored (free), Mode 1 = ERC-20 token payment
    uint8 public constant MODE_SPONSORED = 0;
    uint8 public constant MODE_ERC20 = 1;

    // ─────────────────────────────────────────────
    //  Storage
    // ─────────────────────────────────────────────

    /// @notice Authorized signers who can sign UserOperation approvals
    mapping(address => bool) public signers;

    /// @notice Accepted ERC-20 tokens and their ETH exchange rate (token/ETH, 18 decimals)
    struct TokenConfig {
        bool accepted;
        uint256 pricePerEth; // how many tokens = 1 ETH (18 dec precision)
        uint8 decimals;
    }
    mapping(address => TokenConfig) public acceptedTokens;

    /// @notice Per-user sponsored gas budget (wei) — 0 = unlimited
    mapping(address => uint256) public userGasBudget;

    /// @notice Cumulative gas spent per user (wei)
    mapping(address => uint256) public userGasSpent;

    /// @notice Daily global sponsored budget (wei)
    uint256 public dailyGlobalBudget;
    uint256 public dailyGlobalSpent;
    uint256 public lastResetTimestamp;

    /// @notice Whether the paymaster is paused
    bool public paused;

    // ─────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────

    event SignerUpdated(address indexed signer, bool enabled);
    event TokenConfigured(address indexed token, bool accepted, uint256 pricePerEth);
    event Deposited(address indexed depositor, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event UserOperationSponsored(address indexed sender, uint256 gasUsed, uint8 mode);
    event DailyBudgetUpdated(uint256 newBudget);
    event UserBudgetSet(address indexed user, uint256 budget);
    event PauseToggled(bool paused);

    // ─────────────────────────────────────────────
    //  Errors
    // ─────────────────────────────────────────────

    error OnlyEntryPoint();
    error PaymasterPaused();
    error InvalidMode();
    error InvalidSignature();
    error SignerNotAuthorized();
    error TokenNotAccepted();
    error InsufficientDeposit();
    error UserBudgetExceeded();
    error DailyBudgetExceeded();
    error InvalidPaymasterData();

    // ─────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PaymasterPaused();
        _;
    }

    // ─────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────

    constructor(
        IEntryPoint _entryPoint,
        address _initialSigner,
        uint256 _dailyBudget
    ) Ownable(msg.sender) {
        entryPoint = _entryPoint;
        signers[_initialSigner] = true;
        dailyGlobalBudget = _dailyBudget;
        lastResetTimestamp = block.timestamp;
        emit SignerUpdated(_initialSigner, true);
    }

    // ─────────────────────────────────────────────
    //  IPaymaster — validatePaymasterUserOp
    // ─────────────────────────────────────────────

    /**
     * @notice Called by EntryPoint before executing a UserOperation.
     *
     * paymasterAndData layout:
     *   [0:20]   paymaster address (stripped by EntryPoint before passing here)
     *   [20:21]  mode (0=sponsored, 1=ERC-20)
     *   [21:41]  validUntil (uint48) + validAfter (uint48) packed in 20 bytes
     *            actually: [20:26] validUntil, [26:32] validAfter
     *   [32:52]  token address (only for MODE_ERC20; zero address for MODE_SPONSORED)
     *   [52:116] 65-byte ECDSA signature over the above fields + userOpHash
     *
     * @return context   ABI-encoded data forwarded to postOp
     * @return validationData packed validUntil/validAfter + sig result
     */
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    )
        external
        override
        onlyEntryPoint
        whenNotPaused
        returns (bytes memory context, uint256 validationData)
    {
        bytes calldata pmData = userOp.paymasterAndData[PAYMASTER_DATA_OFFSET:];

        if (pmData.length < 32 + 65) revert InvalidPaymasterData();

        uint8 mode = uint8(pmData[0]);
        uint48 validUntil = uint48(bytes6(pmData[1:7]));
        uint48 validAfter = uint48(bytes6(pmData[7:13]));
        address token = address(bytes20(pmData[13:33]));
        bytes calldata sig = pmData[33:98]; // 65 bytes

        if (mode != MODE_SPONSORED && mode != MODE_ERC20) revert InvalidMode();
        if (mode == MODE_ERC20 && !acceptedTokens[token].accepted) revert TokenNotAccepted();

        // Reconstruct signed hash
        bytes32 dataHash = _getPaymasterDataHash(
            userOp, userOpHash, mode, validUntil, validAfter, token
        );
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(dataHash);
        address recovered = ethSignedHash.recover(sig);

        if (!signers[recovered]) {
            // Return failure with timing constraints still applied
            return (
                "",
                _packValidationData(SIG_VALIDATION_FAILED, validUntil, validAfter)
            );
        }

        // Budget check (sponsored mode only; ERC-20 mode is self-funded)
        if (mode == MODE_SPONSORED) {
            _checkAndAccrueBudget(userOp.sender, maxCost);
        }

        context = abi.encode(
            userOp.sender,
            mode,
            token,
            maxCost,
            uint256(block.timestamp)
        );

        validationData = _packValidationData(SIG_VALIDATION_SUCCESS, validUntil, validAfter);
    }

    // ─────────────────────────────────────────────
    //  IPaymaster — postOp
    // ─────────────────────────────────────────────

    /**
     * @notice Called by EntryPoint after the UserOperation executes.
     *         Collects ERC-20 payment if applicable.
     */
    function postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) external override onlyEntryPoint {
        (
            address sender,
            uint8 payMode,
            address token,
            ,
            // maxCost
            // startTime (unused here)
        ) = abi.decode(context, (address, uint8, address, uint256, uint256));

        if (payMode == MODE_ERC20 && mode != PostOpMode.postOpReverted) {
            TokenConfig memory cfg = acceptedTokens[token];
            // token amount = actualGasCost (wei) * pricePerEth / 1e18
            uint256 tokenAmount = (actualGasCost * cfg.pricePerEth) / 1e18;
            IERC20(token).safeTransferFrom(sender, address(this), tokenAmount);
        }

        emit UserOperationSponsored(sender, actualGasCost, payMode);
    }

    // ─────────────────────────────────────────────
    //  Internal Helpers
    // ─────────────────────────────────────────────

    function _getPaymasterDataHash(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint8 mode,
        uint48 validUntil,
        uint48 validAfter,
        address token
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                userOpHash,
                address(this),
                block.chainid,
                mode,
                validUntil,
                validAfter,
                token
            )
        );
    }

    function _checkAndAccrueBudget(address user, uint256 gasCost) internal {
        // Reset daily counter if needed
        if (block.timestamp >= lastResetTimestamp + 1 days) {
            dailyGlobalSpent = 0;
            lastResetTimestamp = block.timestamp;
        }

        if (dailyGlobalBudget > 0) {
            if (dailyGlobalSpent + gasCost > dailyGlobalBudget) revert DailyBudgetExceeded();
            dailyGlobalSpent += gasCost;
        }

        uint256 budget = userGasBudget[user];
        if (budget > 0) {
            if (userGasSpent[user] + gasCost > budget) revert UserBudgetExceeded();
        }
        userGasSpent[user] += gasCost;
    }

    function _packValidationData(
        uint256 sigResult,
        uint48 validUntil,
        uint48 validAfter
    ) internal pure returns (uint256) {
        return sigResult | (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    // ─────────────────────────────────────────────
    //  Admin — Deposit / Withdraw
    // ─────────────────────────────────────────────

    /// @notice Deposit ETH into EntryPoint to fund gas sponsoring
    function deposit() external payable onlyOwner {
        entryPoint.depositTo{value: msg.value}(address(this));
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Withdraw ETH from EntryPoint
    function withdraw(address payable to, uint256 amount) external onlyOwner nonReentrant {
        entryPoint.withdrawTo(to, amount);
        emit Withdrawn(to, amount);
    }

    /// @notice Withdraw accumulated ERC-20 tokens
    function withdrawTokens(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(to, amount);
    }

    // ─────────────────────────────────────────────
    //  Admin — Configuration
    // ─────────────────────────────────────────────

    function setSigner(address signer, bool enabled) external onlyOwner {
        signers[signer] = enabled;
        emit SignerUpdated(signer, enabled);
    }

    function configureToken(
        address token,
        bool accepted,
        uint256 pricePerEth,
        uint8 decimals
    ) external onlyOwner {
        acceptedTokens[token] = TokenConfig(accepted, pricePerEth, decimals);
        emit TokenConfigured(token, accepted, pricePerEth);
    }

    function setDailyBudget(uint256 budget) external onlyOwner {
        dailyGlobalBudget = budget;
        emit DailyBudgetUpdated(budget);
    }

    function setUserBudget(address user, uint256 budget) external onlyOwner {
        userGasBudget[user] = budget;
        emit UserBudgetSet(user, budget);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    // ─────────────────────────────────────────────
    //  Views
    // ─────────────────────────────────────────────

    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    function getRemainingDailyBudget() external view returns (uint256) {
        if (dailyGlobalBudget == 0) return type(uint256).max;
        if (dailyGlobalSpent >= dailyGlobalBudget) return 0;
        return dailyGlobalBudget - dailyGlobalSpent;
    }

    function getUserRemainingBudget(address user) external view returns (uint256) {
        uint256 budget = userGasBudget[user];
        if (budget == 0) return type(uint256).max;
        uint256 spent = userGasSpent[user];
        if (spent >= budget) return 0;
        return budget - spent;
    }

    // ─────────────────────────────────────────────
    //  Fallback — receive plain ETH top-ups
    // ─────────────────────────────────────────────

    receive() external payable {}
}
