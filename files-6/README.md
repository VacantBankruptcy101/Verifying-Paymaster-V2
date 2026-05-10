# VerifyingPaymaster — ERC-4337 Gas Sponsorship Contract

A production-ready ERC-4337 Paymaster supporting:

- **Sponsored (gasless)** transactions — dApp pays all gas
- **ERC-20 gas payments** — users pay in USDC, DAI, or any configured token
- **Per-user spending caps** and **global daily budget** enforcement
- **Off-chain signature validation** — a trusted signer authorises each UserOperation
- **Pause / unpause** circuit breaker
- **Etherscan-verified** deployment script

---

## Architecture

```
User Wallet (EOA or Smart Account)
        │
        │  UserOperation
        ▼
  Bundler / Alt-Mempool
        │
        │  handleOps()
        ▼
  EntryPoint v0.7  ◄────────────────────────────────────────────┐
  0x0000000071727De22E5E9d8BAf0edAc6f37da032                    │
        │                                                         │
        │  validatePaymasterUserOp()     postOp()                │
        ▼                                ▼                        │
  VerifyingPaymaster  ◄──── deposit (ETH) ──────────────────────┘
        │
        │  ECDSA.recover(sig) ── off-chain Signer backend
        │
        ├── MODE_SPONSORED:  EntryPoint deposit debited
        └── MODE_ERC20:      ERC-20.transferFrom(user → paymaster)
```

---

## Quick Start

```bash
git clone <repo>
cd verifying-paymaster
npm install

cp .env.example .env
# fill in SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY

# Compile
npm run compile

# Run tests
npm test

# Deploy to Sepolia
npm run deploy:sepolia
```

---

## paymasterAndData Layout

After the 20-byte paymaster address that EntryPoint prepends:

| Bytes   | Field        | Type    | Notes                              |
|---------|--------------|---------|------------------------------------|
| [0]     | mode         | uint8   | 0 = sponsored, 1 = ERC-20          |
| [1:7]   | validUntil   | uint48  | Unix timestamp; 0 = no expiry      |
| [7:13]  | validAfter   | uint48  | Unix timestamp; 0 = immediately    |
| [13:33] | token        | address | ERC-20 address; zero if sponsored  |
| [33:98] | signature    | bytes65 | ECDSA over hash of above fields    |

Use `scripts/paymasterSigner.js` to build and sign this data on your backend.

---

## Security Considerations

1. **Signer key hygiene** — keep the signing key on a dedicated, rate-limited backend service. Rotate it via `setSigner()` if compromised.
2. **Replay protection** — the signature commits to `userOpHash`, `chainId`, and `address(this)`, preventing cross-chain and cross-contract replay.
3. **Budget limits** — set both `dailyGlobalBudget` and per-user limits to bound worst-case losses.
4. **Pause** — use `setPaused(true)` immediately if anomalous activity is detected.
5. **ERC-20 approval** — for MODE_ERC20, the user's smart account must approve the paymaster to spend tokens before the UserOperation is submitted.
6. **EntryPoint deposit** — monitor via `getDeposit()` and top up regularly; a depleted deposit causes all sponsored UserOps to fail.

---

## EntryPoint v0.7 Address

`0x0000000071727De22E5E9d8BAf0edAc6f37da032` — same on Ethereum, Sepolia, Base, Optimism, Arbitrum, Polygon, and all other ERC-4337-compatible chains.

---

## License

MIT
