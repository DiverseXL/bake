# Requirements

This page covers what you need installed before using `bake`, split by which commands actually need each piece. Not every requirement applies to every command — `bake login`, `bake use`, `bake whoami`, `bake stats`, `bake logs`, and `bake decode` are pure TypeScript/RPC and need nothing beyond Node.js.

Run `bake doctor` at any time to check your environment against this list automatically.

## Always required

| Requirement | Why | Check |
|---|---|---|
| **Node.js ≥ 22** | Runtime for the CLI itself, and required by the `cookie-mcp` integration | `node --version` |
| **npm** (ships with Node) | To install bake | `npm --version` |

Install: [nodejs.org](https://nodejs.org) or a version manager like [nvm](https://github.com/nvm-sh/nvm).

## Required for build/deploy commands

Applies to: `bake deploy`, `bake rollback`, `bake init`, `bake fork`, `bake prove --rebuild`, `bake diff --rebuild`

| Requirement | Why | Check |
|---|---|---|
| **Rust** (rustc 1.89+) | Compiles Anchor programs | `rustc --version` |
| **Solana CLI / Agave toolchain** | `cargo-build-sbf`, `solana-test-validator`, and related tooling | `solana --version` |
| **Anchor CLI** (via [avm](https://www.anchor-lang.com/docs/installation)) | Builds and deploys Anchor programs | `anchor --version` |

Install (macOS/Linux, or inside WSL on Windows — see below):
```bash
# Rust
curl https://sh.rustup.rs -sSf | sh

# Solana / Agave
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Anchor via avm
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest && avm use latest
```

### Windows-specific note

The Solana/Anchor build toolchain does not run reliably on native Windows — this is a known ecosystem-wide limitation, not specific to bake (even the official Anchor CLI requires this).

**You don't need to work around this yourself.** `bake` auto-detects native Windows and transparently relays build/deploy commands through WSL. You just need WSL itself set up once:

1. Open an **Admin PowerShell** and run:
   ```powershell
   wsl --install
   ```
2. Reboot when prompted, then complete the Ubuntu setup (choose a username/password).
3. Inside the new Ubuntu terminal, install Rust, Solana, and Anchor using the commands above.
4. From then on, just run `bake deploy` etc. from a normal Windows terminal (PowerShell, cmd, or inside an IDE) — bake handles the WSL bridging invisibly.

Run `bake doctor` to confirm WSL and the toolchain inside it are detected correctly.

## Required for a real (non-local) deploy

| Requirement | Why |
|---|---|
| **A funded wallet** | Deploys cost a small amount of COOK (Cookie Chain's native token) — typically a few cents' worth per deploy |

For local development and testing, you don't need real funds at all — point `bake use` at a local `solana-test-validator` and airdrop test SOL freely.

To get real COOK for a live Cookie Chain deploy: bridge from Solana via [bridge.cookiescan.io](https://cookiescan.io), or ask in the [Cookie Chain Telegram](https://t.me/TheCookieNetChain)/[Discord](https://discord.gg/XqnStmWgNu).

## Required for `bake login --wallet nightly`

| Requirement | Why |
|---|---|
| **[Nightly Wallet](https://nightly.app)** (mobile app) | Scans the QR session for high-stakes deploy/rollback confirmations |

This is optional — `bake login` with no flags creates or uses a local keypair by default, which is all most day-to-day usage needs.

## Required for `bake mcp`'s `bake_check_token_liquidity` tool

Nothing extra — `cookie-mcp` is bundled as a direct dependency of `bake` and spawns automatically on first use of that specific tool.

## Summary: minimum setup for each use case

| I want to... | I need |
|---|---|
| Check my wallet/cluster, view logs, get stats | Just Node.js |
| Deploy, rollback, or fork a program | Node.js + Rust + Solana CLI + Anchor (native, or via WSL on Windows) |
| Deploy for real on Cookie Chain | The above, plus a small amount of COOK |
| Use bake as an AI agent's tool server | Just Node.js (write access needs an explicit policy file — see [AGENTS.md](./AGENTS.md)) |
