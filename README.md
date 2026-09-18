# bake 🍪

**The Vercel CLI for Cookie Chain.** Build, deploy, verify, and roll back Anchor programs in seconds — with every deploy permanently recorded on-chain.

```
   .-'''-.
  /  o  o \
 |  o    o     bake!
  \  o  o /
   `-...-'
```

[![npm version](https://img.shields.io/npm/v/bakeacookie.svg)](https://www.npmjs.com/package/bakeacookie)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## Live on Cookie Chain

The Recipe Book program is deployed and verified on Cookie Chain mainnet:

- **Program ID:** `56Vj61zFW4hHV6wdjnisrHtVwWDqyjixjpBgnoRJvzxL`
- **Explorer:** https://cookiescan.io/address/56Vj61zFW4hHV6wdjnisrHtVwWDqyjixjpBgnoRJvzxL
- **Status:** Executable, upgradeable BPF program

## Why bake exists

[Cookie Chain](https://www.cookiechain.wtf) is a fast, cheap, community-owned SVM blockchain — programs deploy for pennies with sub-second finality. But developer tooling on Cookie Chain today is almost entirely vanilla Solana CLI pointed at a different RPC endpoint. There's no deployment orchestration, no on-chain deploy history, no casual rollback, and no security-gated deploy flow — gaps the ecosystem's own roadmap lists as future work.

**bake closes that gap now.** Every command is designed around one idea: Cookie Chain's economics make things possible that are impractical anywhere else — like a rollback that costs cents, or a permanent, on-chain, queryable ledger of every deploy you've ever made.

## What makes bake different

- **On-chain deploy history.** Every `bake deploy` registers a permanent record — commit, build hash, deployer, timestamp — in a small on-chain Anchor program called the **Recipe Book**. Nothing else in the ecosystem does this.
- **Cross-platform by default.** Anchor/Solana's build toolchain doesn't run natively on Windows — even the official Anchor CLI needs WSL. `bake` auto-detects native Windows and transparently relays toolchain-dependent commands through WSL, so Windows developers get the same one-command experience as macOS/Linux, without manually bridging shells.
- **Cheap, honest rollback.** `bake rollback` rebuilds and redeploys a previous commit, verified with a git-state safety net that's been tested against deliberate mid-operation failures — your working directory is never left in a broken state.
- **Cryptographic proof, not just trust.** `bake prove` verifies that what's actually running on-chain matches what your Recipe Book says was deployed, using real ELF-binary hash comparison — not a guess.
- **Agent-native.** `bake mcp` exposes bake's capabilities to AI agents over the Model Context Protocol, with a safety-first design: write operations (deploy, rollback) are completely invisible to an agent unless an explicit policy file enables them, and even then require a second confirming call before executing.
- **Agent-ready scaffold.** `bake agent init` sets up an AI-agent project pre-wired for `bake mcp` (and optional `cookie-mcp`) with a strict read-only policy by default and zero private keys in the scaffold.
- **Local session workspaces.** `bake session` spins up disposable, isolated workspaces with ephemeral keypairs and optional local validators — rehearse deploys locally without touching your global wallet or cluster configuration.
- **Security-gated deploys, honestly sourced.** `bake audit` runs [Radar](https://github.com/auditware/radar) — Auditware's static analyzer for Anchor/Rust contracts, the tool the Solana docs recommend — and `bake deploy --require-audit` refuses to ship critical or high findings. bake ships **no hand-rolled security heuristics**: every finding is Radar's, labelled "powered by Radar".
- **Genuinely cross-chain, not just architecturally.** The full pipeline (deploy, prove, logs, stats) has been tested end-to-end on Solana devnet, not just Cookie Chain, with zero code changes required.

## Install

```bash
npm install -g bakeacookie
```

> **Note:** During install you may see `npm warn` messages about peer dependency conflicts (e.g. `@coral-xyz/anchor` version mismatches). These come from a transitive dependency inside `cookie-mcp` and are already resolved automatically by npm — reviewed and confirmed safe as part of a full security audit (see AGENTS.md §11.1). No action needed.

The package is published as `bakeacookie` (the shorter names were already taken), but the command you run is just:

```bash
bake --help
```

**Windows users:** bake needs a Solana/Anchor toolchain available via WSL for build/deploy commands. Run `bake doctor` after install to check your environment.

## Requirements

Not every command needs the full toolchain — `bake login`, `bake use`, `bake whoami`, `bake stats`, `bake logs`, and `bake decode` work with just Node.js. For build/deploy commands you'll also need Rust, Solana CLI, and Anchor (or WSL on Windows). `bake audit` additionally requires [Radar](https://github.com/auditware/radar) plus a running Docker daemon (bake prints the one-line Radar install command if it's missing — it never installs a security scanner for you silently). See [REQUIREMENTS.md](./REQUIREMENTS.md) for the full breakdown by use case.

## Quickstart

```bash
bake login                 # creates or links a local wallet — zero ceremony
bake use cookie             # point at Cookie Chain (or: mainnet, devnet, a local validator URL)
bake init my-program        # scaffold a new Anchor project, pre-wired for Cookie Chain
cd my-program
bake deploy                 # build → deploy → hash → register on-chain, all in one command
bake logs -f                # watch it live
```

## Command reference

| Command | Description |
|---|---|
| `bake login` | Local keypair by default (zero ceremony); `--wallet nightly` for high-stakes confirmations |
| `bake use [cluster\|url]` | Switch active cluster (`cookie`, `mainnet`, `devnet`, or any RPC URL) |
| `bake whoami` | Show active wallet(s) and cluster |
| `bake init [name]` | Scaffold a new Anchor project pre-wired for Cookie Chain |
| `bake deploy` | Build, deploy, hash, and register the deploy in the on-chain Recipe Book; `--require-audit` gates on `bake audit`. After deploying, view your deploy history on the [dashboard](https://bakeacookie.vercel.app/program/<program-id>) |
| `bake audit [path]` | Static analysis for Anchor programs (wraps Radar) — flags high-severity findings; `bake deploy --require-audit` gates deploys on a clean scan |
| `bake rollback [entry]` | Rebuild and redeploy a previous Recipe Book entry; `--program <addr>` to skip Anchor.toml detection |
| `bake logs [programId]` | View recent or live-streamed (`-f`) program logs, with Anchor event decoding |
| `bake prove [entry]` | Verify on-chain bytecode matches a Recipe Book entry; `--rebuild` for full proof; `--program <addr>` to skip Anchor.toml detection |
| `bake diff [entry]` | Show what's changed (source and, with `--rebuild`, bytecode) since a given deploy |
| `bake decode <sig\|--account>` | Decode a transaction or account using a program's IDL |
| `bake stats [programId]` | Program activity (invocations, error rate, unique signers, CU) plus CookieScan network context |
| `bake fork <programId>` | Clone a program (and optionally its accounts) from any cluster into a local validator |
| `bake doctor` | Full environment health check (Node, git, WSL, wallet, cluster, balance, project) |
| `bake dashboard [address]` | Open the web dashboard in your browser — `/program/<address>` with arg, homepage without; `--ci` prints URL instead of launching browser |
| `bake mcp` | Run bake as an MCP server for AI agents, with policy-gated write access |
| `bake agent init [name]` | Scaffold an AI-agent project pre-wired to `bake mcp` (read-only policy by default); `--with-cookie-mcp` / `--no-cookie-mcp`, `--force`, `-y` |
| `bake session open` | Start a disposable local workspace (ephemeral keypair; optional local validator); `--port`, `--no-validator`, `--workspace <path>`, `--force`, `-y` |
| `bake session status` | Show the active session (ID, keypair pubkey, RPC URL, validator PID and status) |
| `bake session deploy` | Deploy the current Anchor project through the active session using process-local overrides; `-y` |
| `bake session close` | Tear down validator, delete ephemeral keys, and clear session state; `-y`, `--keep-workspace` |

Every command supports `--ci` (plain, color-free output) and `--json` (structured output for scripting).

## Sessions (local disposable workspaces)

`bake session` creates disposable, local deploy workspaces so you can rehearse builds and deploys with an ephemeral keypair and an optional isolated `solana-test-validator`, without modifying your global wallet or active cluster config (`~/.bake/config.json`).

### Typical workflow

```bash
# 1. Open a new session (generates ephemeral keypair + starts local validator on port 8899)
bake session open

# 2. Check active session details (pubkey, RPC, validator PID)
bake session status

# 3. Deploy an Anchor project into the active session
bake session deploy

# 4. Tear down validator and purge ephemeral keys when done
bake session close -y
```

### Key behaviors & flags

- **Process-local overrides:** `bake session deploy` applies temporary environment overrides (`ANCHOR_PROVIDER_URL`, `ANCHOR_WALLET`, `BAKE_RPC_URL`) strictly for the duration of the deploy pipeline and restores process state afterward. Your global `bake use` setting is untouched.
- **Keypair-only sessions (`--no-validator`):** Run `bake session open --no-validator` to generate an isolated ephemeral keypair without launching a local validator process (e.g. for testing against an existing RPC).
- **Custom port & workspace:** Use `--port <number>` (default `8899`) to avoid port collisions, and `--workspace <path>` (default `cwd`) to specify which project directory to bind to the session.
- **Single active session:** Only one session can be active at a time. If an existing session is running, close it first with `bake session close` or pass `--force` to `bake session open`.
- **Windows / WSL:** Background validators run through the WSL toolchain relay. Always close sessions cleanly to avoid orphaned validator processes.

## AI agents (`bake agent init` & `bake mcp`)

`bake agent init [name]` scaffolds a complete, minimal AI-agent project configured to communicate with `bake mcp` over stdio via the Model Context Protocol (MCP).

```bash
bake agent init my-agent
cd my-agent
```

### Project structure

```
my-agent/
├── README.md                # Agent setup & write-access guide
├── package.json             # Minimal metadata + mcp:bake script
├── .gitignore               # Ignores .env, keypairs (*.json), .bake/
├── policy.example.json      # Read-only MCP policy (allowWrites: false)
├── prompts/
│   └── system.md            # System prompt with tool definitions & safety rules
└── mcp/
    ├── mcp.json             # MCP server config for Cursor / Claude Desktop
    └── README.md            # Integration guide for AI editors
```

### Connecting your AI editor

1. **Cursor:** Copy the `mcpServers` object from `mcp/mcp.json` into `.cursor/mcp.json` (project-level) or `~/.cursor/mcp.json` (global).
2. **Claude Desktop:** Merge the server definition into `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows).
3. **Verify:** Ask your assistant `run bake_whoami` to inspect the active wallet and cluster.

### Safety model & write permissions

- **Read-only by default:** The generated `policy.example.json` sets `"allowWrites": false`. Write tools (`bake_deploy`, `bake_rollback`) are **completely unregistered** from the MCP tool list until write access is explicitly enabled.
- **Enabling writes:** Copy `policy.example.json` to `.bake/mcp-policy.json` (or pass `--policy <path>`) and set `"allowWrites": true`.
- **Confirmation tokens:** When writes are enabled, `requireConfirmation: true` enforces a two-step confirmation flow: write tools return a preview with a 5-minute confirmation token, and the action only executes when `bake_confirm_action` is called with that token.
- **No private keys in scaffold:** The scaffold contains **no private keys or seed phrases**. Agent tools use local wallets loaded from disk by the bake CLI.
- **cookie-mcp integration:** Included by default in `mcp/mcp.json` for read-only token and liquidity lookups (DEX prices, pools). Omit with `--no-cookie-mcp` if not needed.
- **Prerequisites:** Node.js ≥ 22 and `bake` installed globally (`npm install -g bakeacookie`).

## How it works

```mermaid
flowchart TD
    Dev[Developer] -->|bake deploy| CLI[bake CLI]

    CLI --> Platform{Windows?}
    Platform -->|Yes| Relay[WSL Toolchain Relay]
    Platform -->|No| Toolchain[Anchor / Solana Toolchain]
    Relay --> Toolchain

    Toolchain -->|anchor build + deploy| Cookie[(Cookie Chain)]
    CLI -->|register_deploy| RecipeBook[[Recipe Book\non-chain program]]
    RecipeBook -.stores.-> Entry[commit · build hash\ndeployer · timestamp]
    RecipeBook --> Cookie

    CLI -->|bake prove| RecipeBook
    CLI -->|bake rollback| Git[Git history] --> Toolchain

    CLI -->|bake stats| CookieScan[CookieScan DAS / REST API]
    CLI -->|bake mcp| Agent[AI Agent]
    Agent -->|policy-gated writes| CLI
    CLI -->|bake_check_token_liquidity| CookieMCP[cookie-mcp\nread-only, isolated]
    CookieMCP --> CookieScan

    style RecipeBook fill:#C68E5B,color:#000
    style Cookie fill:#F4D03F,color:#000
```

## Architecture

- `src/commands/` — one file per CLI command
- `src/lib/deployPipeline.ts` — the single, shared build→deploy→hash→register implementation used by both `deploy` and `rollback`; also configures the Solana CLI target (`solana config set --url`) before every real deploy to prevent Anchor from silently targeting localhost
- `src/lib/toolchain.ts` — cross-platform Anchor/Solana subprocess runner, including the Windows→WSL relay
- `src/lib/recipeBook.ts` — Recipe Book client (real, on-chain) with a mock implementation for testing command orchestration
- `src/idl/recipe_book.json` — hand-written, live-validated IDL (a durable fallback alongside auto-generation)
- `anchor/programs/recipe_book/` — the on-chain Recipe Book Anchor program
- `src/lib/mcpServer.ts` / `mcpPolicy.ts` — the MCP server and its write-policy gating
- See [AGENTS.md](./AGENTS.md) for detailed internals, known toolchain gotchas, and the full failure-signature reference gathered during development.

## Vision & Roadmap

What's shipped today already turns Cookie Chain's cost/speed advantage into daily muscle memory. Where this is headed:

- **`bake fork` enhancements** — deeper Solana mainnet rehearsal workflows
- **Multisig-first upgrades** — `bake deploy --authority multisig`, proposal/execution flow
- **`bake top`** — deferred (needs chain-wide indexing; not in CLI v0)
- **Companion web dashboard** — wallet-connected visualization of your Recipe Book deploy history — live at [bakeacookie.vercel.app](https://bakeacookie.vercel.app)

The goal: if you're deploying a program on Cookie Chain, you should be using bake.

## Companion dashboard

A web dashboard for visualizing Recipe Book deploy history, connected via Nightly wallet: **[bakeacookie.vercel.app](https://bakeacookie.vercel.app)**. View the live Recipe Book program's deploy history at [/program/56Vj61zFW4hHV6wdjnisrHtVwWDqyjixjpBgnoRJvzxL](https://bakeacookie.vercel.app/program/56Vj61zFW4hHV6wdjnisrHtVwWDqyjixjpBgnoRJvzxL).

## Contributing

Issues and PRs welcome. Read [AGENTS.md](./AGENTS.md) first if you're using an AI coding agent to contribute — it documents hard-won toolchain constraints that are easy to accidentally re-break.

## License

MIT
