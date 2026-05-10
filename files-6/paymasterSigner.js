// scripts/paymasterSigner.js
// ──────────────────────────────────────────────────────────────
// Off-chain helper: build & sign paymasterAndData for
// VerifyingPaymaster.  Use this in your bundler backend or
// relayer service.
// ──────────────────────────────────────────────────────────────
const { ethers } = require("ethers");

const MODE_SPONSORED = 0;
const MODE_ERC20     = 1;

/**
 * Build and sign the paymasterAndData field.
 *
 * @param {object}  opts
 * @param {string}  opts.paymasterAddress   Deployed VerifyingPaymaster address
 * @param {object}  opts.userOp             Partial UserOperation (must include sender, nonce, etc.)
 * @param {string}  opts.userOpHash         keccak256 hash of the packed UserOperation
 * @param {ethers.Signer} opts.signerWallet  Hot wallet that is an authorised signer
 * @param {number}  opts.mode               0 = sponsored, 1 = ERC-20
 * @param {number}  [opts.validUntilSec]    Unix timestamp (default: now + 5 min)
 * @param {number}  [opts.validAfterSec]    Unix timestamp (default: 0)
 * @param {string}  [opts.tokenAddress]     ERC-20 address (required for MODE_ERC20)
 * @param {number}  [opts.chainId]          (default: fetched from provider)
 * @returns {Promise<string>}  Full paymasterAndData hex string
 */
async function buildPaymasterData(opts) {
  const {
    paymasterAddress,
    userOpHash,
    signerWallet,
    mode = MODE_SPONSORED,
    validUntilSec = Math.floor(Date.now() / 1000) + 300,
    validAfterSec = 0,
    tokenAddress = ethers.ZeroAddress,
    chainId,
  } = opts;

  const resolvedChainId =
    chainId ?? (await signerWallet.provider.getNetwork()).chainId;

  // ── Hash the fields we're committing to ────────────────────
  const dataHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "uint256", "uint8", "uint48", "uint48", "address"],
      [
        userOpHash,
        paymasterAddress,
        resolvedChainId,
        mode,
        validUntilSec,
        validAfterSec,
        tokenAddress,
      ]
    )
  );

  // ── Sign (produces Ethereum prefixed hash internally) ──────
  const signature = await signerWallet.signMessage(ethers.getBytes(dataHash));

  // ── Encode paymasterAndData ─────────────────────────────────
  // Layout (after the 20-byte paymaster address that EntryPoint prepends):
  //   [0]      mode        (1 byte)
  //   [1:7]    validUntil  (6 bytes / uint48)
  //   [7:13]   validAfter  (6 bytes / uint48)
  //   [13:33]  token       (20 bytes)
  //   [33:98]  signature   (65 bytes)
  const encoded = ethers.concat([
    ethers.getBytes(paymasterAddress),                      // 20 bytes
    new Uint8Array([mode]),                                  //  1 byte
    ethers.toBeArray(BigInt(validUntilSec)).padStart
      ? _padBytes(validUntilSec, 6)                          //  6 bytes
      : _padBytes(validUntilSec, 6),
    _padBytes(validAfterSec, 6),                             //  6 bytes
    ethers.getBytes(tokenAddress),                           // 20 bytes
    ethers.getBytes(signature),                              // 65 bytes
  ]);

  return ethers.hexlify(encoded);
}

/** Zero-pad a number to `len` bytes (big-endian) */
function _padBytes(value, len) {
  const hex = BigInt(value).toString(16).padStart(len * 2, "0");
  return ethers.getBytes("0x" + hex);
}

// ── Example usage ─────────────────────────────────────────────

async function exampleSponsoredUserOp() {
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const signerWallet = new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY, provider);

  // In a real bundler flow, userOpHash comes from the EntryPoint
  const DUMMY_USEROP_HASH = ethers.keccak256(ethers.toUtf8Bytes("example"));

  const paymasterAndData = await buildPaymasterData({
    paymasterAddress: process.env.PAYMASTER_ADDRESS,
    userOpHash: DUMMY_USEROP_HASH,
    signerWallet,
    mode: MODE_SPONSORED,
  });

  console.log("paymasterAndData (sponsored):", paymasterAndData);
}

async function exampleERC20UserOp() {
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const signerWallet = new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY, provider);

  const DUMMY_USEROP_HASH = ethers.keccak256(ethers.toUtf8Bytes("example-erc20"));
  const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

  const paymasterAndData = await buildPaymasterData({
    paymasterAddress: process.env.PAYMASTER_ADDRESS,
    userOpHash: DUMMY_USEROP_HASH,
    signerWallet,
    mode: MODE_ERC20,
    tokenAddress: USDC_SEPOLIA,
  });

  console.log("paymasterAndData (ERC-20/USDC):", paymasterAndData);
}

if (require.main === module) {
  exampleSponsoredUserOp().catch(console.error);
}

module.exports = { buildPaymasterData, MODE_SPONSORED, MODE_ERC20 };
