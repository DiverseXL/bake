# AGENTS.md — Rules for AI coding agents working on `bake`

This file exists because getting this project's toolchain working took an
entire debugging saga. Every rule below was earned the hard way. Read this
file fully before touching build/deploy/toolchain code. If you're about to
"simplify" or "clean up" something that looks unusual, **read the comment
next to it first** — it's very likely there for a reason that isn't obvious
from the code alone.

---

## 1. What `bake` is

`bake` is a CLI developer tool for Cookie Chain (a fast, cheap,
Solana-compatible SVM blockchain), built for the Superteam Earn "Create an
app on Cookie Chain" hackathon listing. Positioning: "the Vercel CLI for
SVM" — one-command build → deploy → verify → rollback, with every deploy
recorded permanently on-chain via a small Anchor program called the
**Recipe Book**.

Secondary positioning (do not let this override primary Cookie Chain
focus — see Section 8): bake's architecture is chain-agnostic (multi-cluster
from day one), so it's pitched as a tool for the wider SVM ecosystem, with
Cookie Chain as the flagship, required, primary target.

---

## 2. CRITICAL RULES — do not violate these

### 2.1 The exact Anchor build command is not optional
```
anchor build --arch v0 --tools-version v1.57
```
**Why `--arch v0` is required:** the default build target is SBPF v3
(newer eBPF instruction set). The local `solana-test-validator` cannot
execute SBPF v3 bytecode and rejects it with `Failed to parse ELF file:
invalid file header`. Forcing `--arch v0` targets an older, universally
compatible instruction set. **Do not remove `--arch v0` "to use defaults."**
It was found only after an entire debugging session eliminated every other
possible cause (compiler/validator version mismatch, corrupted caches,
stale buffers) — the version numbers matching does NOT mean this flag is
safe to drop.

**Why `--tools-version v1.57` is pinned:** avoids ambiguity/drift in which
platform-tools version gets auto-selected across machines.

`--no-idl` is **no longer needed** — IDL auto-generation was confirmed
working once the above flags were correct (an earlier failure was
transient filesystem flakiness on the Windows-mounted path, not a real
bug). Do not reintroduce `--no-idl` without confirming IDL generation is
actually broken again first.

### 2.2 Two independent, both-valid IDL sources exist — do not delete either
- **Auto-generated**: `/anchor/target/idl/recipe_book.json` (produced by
  `anchor build`)
- **Hand-written**: `src/idl/recipe_book.json` (written and live-validated
  against the deployed program when auto-generation was temporarily
  broken)

`RealRecipeBookClient` currently uses the hand-written one. Both are
proven correct via live on-chain calls. **Do not delete the hand-written
one** — it's the durable fallback if toolchain issues ever break
auto-generation again. If you switch the client to the auto-generated
one, validate it the same rigorous way first: a real `initialize_recipe_book`
+ `register_deploy` call against a running validator, not just "it parses."

### 2.3 Windows requires the WSL relay — never shell out to `anchor`/`solana` directly on win32
Use `src/lib/toolchain.ts`'s `runToolchainCommand()` / `runAnchorBuild()`
for **any** subprocess call to `anchor`, `solana`, or `cargo-build-sbf`.
Never `child_process.spawn('anchor', ...)` directly in command code — on
native Windows this fails immediately (PowerShell has no `anchor` binary;
it only exists inside WSL). The toolchain runner auto-detects
`process.platform === 'win32'` and transparently relays through
`wsl -d Ubuntu -e bash -lc "..."`, sourcing the WSL-side cargo/nvm/solana
PATH explicitly (non-interactive WSL shells do not reliably inherit
profile-sourced PATH — this is not optional boilerplate, it silently
breaks without it).

### 2.4 Environment variables do not persist across separate `wsl -e bash -lc "..."` calls
Each `wsl -e bash -lc "..."` invocation is a fresh shell. `export X=y` in
one call is invisible in the next call. Any env vars a command needs
(`ANCHOR_PROVIDER_URL`, `ANCHOR_WALLET`, `PATH` additions) must be set
**inside the same command string** as the command that needs them.

### 2.5 Git-state-mutating operations (`rollback`, `prove --rebuild`) MUST use try/finally to restore state
Any command that does `git checkout <other commit>` (rollback.ts,
prove.ts's `--rebuild` path) must restore the original branch/commit in a
`finally` block, guaranteed to run even if the build/deploy fails
mid-operation. This was explicitly tested by deliberately breaking a
build mid-rollback (renaming the anchor binary) — the restore fired
correctly. **Any new command that touches git state must pass the same
test before being considered done**: break it on purpose, confirm restore
still happens.

### 2.6 Never leave two copies of the same deploy logic
`src/lib/deployPipeline.ts`'s `runDeployPipeline()` is the ONE
implementation of build→deploy→hash→register. Both `deploy.ts` and
`rollback.ts` call it. **Do not let a new command reimplement any part of
this inline** — it will drift from the shared version the moment either
gets a bugfix and the other doesn't. Extend `deployPipeline.ts`, don't
duplicate around it.

### 2.7 Windows paths with spaces
The dev machine's path is `/mnt/c/Users/MY PC/Documents/bake` — note the
space in "MY PC". Any shell command touching this path must quote it
properly (`"..."` or `'...'` depending on context — WSL relay code already
handles this via `windowsPathToWsl()`, but any NEW manual shell
invocation must not forget this).

### 2.8 Never run `npm install` from PowerShell for anything meant to run in WSL, or vice versa
Native binaries (esbuild, etc.) in `node_modules` are platform-specific.
Windows-installed `node_modules` breaks under WSL (`@esbuild/win32-x64`
vs `@esbuild/linux-x64` mismatch) and likely the reverse too. If a
dependency error mentions a platform mismatch, the fix is deleting
`node_modules`/`package-lock.json` and reinstalling **from the
environment that will actually run the code**, not patching around it.

### 2.9 MCP write tools are UNREGISTERED without an explicit policy — never "register but block"
`bake mcp` exposes bake to AI agents over stdio. **Read-only tools are always
registered. Write tools (`bake_deploy`, `bake_rollback`, `bake_confirm_action`)
must not appear in the tool list at all unless a policy file sets
`allowWrites: true`.** Hiding them (not merely refusing at call time) is
intentional: an agent cannot be tricked into calling a tool it does not know
exists. Do not "simplify" this into register-everything-and-check-flags —
see Section 10 for the full safety model (confirmation tokens, session
circuit breaker, stderr audit log). Implemented in `src/commands/mcp.ts`,
`src/lib/mcpServer.ts`, `src/lib/mcpPolicy.ts`.

---

## 3. Architecture map

```
src/
  index.ts              — entrypoint, registers commands, --ci/--json/-v global flags
  commands/
    init.ts              — scaffold Anchor project via toolchain + Cookie Chain overlays
    login.ts             — local keypair (default) + Nightly Connect (--wallet nightly, for
                            high-stakes confirmations only, NOT default login path)
    use.ts                — cluster switching, v1 web3.js Connection-based reachability probe
    whoami.ts             — shows active wallet(s) + cluster
    deploy.ts             — thin UI wrapper around runDeployPipeline()
    rollback.ts           — UI + confirm around runRollbackPipeline() (lib/rollbackPipeline.ts)
    logs.ts               — history + --follow live streaming, basic Anchor log line parsing
    prove.ts               — Level 1 (on-chain hash check) + Level 2 (--rebuild, full reproducibility)
    stats.ts               — RPC-derived program activity + CookieScan network context (REST only,
                            NOT program analytics — see Section 5); exports collectProgramStats()
    mcp.ts                 — stdio MCP server entry (policy load + startBakeMcpServer)
    diff.ts               — source + optional bytecode diff against Recipe Book entry (read-only)
    decode.ts              — transaction/account/log decoding via Anchor IDLs (uses idlRegistry.ts)
    fork.ts               — clone a program + accounts from a source cluster into local validator
    doctor.ts             — environment diagnostic: composes existing checks (toolchain.ts checkWslToolchain,
                            wallet.ts resolveWalletPath, connection.ts probe, anchorProject detection,
                            Node version gate) into a pass/warn/fail report; --json/--ci supported;
                            exit 0 for warnings, non-zero only for genuine failures
    top.ts                — STUB (not yet implemented)
  lib/
    connection.ts          — getConnection()/getActiveCluster(), v1 @solana/web3.js ONLY (see 3.1)
    toolchain.ts            — cross-platform Anchor/Solana subprocess runner (Section 2.3);
                              runToolchainCommand (buffered), spawnToolchainForeground (live streaming
                              for long-running processes like solana-test-validator)
    deployPipeline.ts        — THE ONE build/deploy/hash/register implementation (Section 2.6)
    rollbackPipeline.ts      — THE ONE rollback implementation (checkout → deployPipeline → restore)
    recipeBook.ts             — RecipeBookClient interface, MockRecipeBookClient,
                              RealRecipeBookClient. getRecipeBookClient() factory:
                              BAKE_MOCK_RECIPE_BOOK=1 env var forces the mock (useful for testing
                              deploy.ts's orchestration without touching a real chain)
    mcpPolicy.ts               — zod-validated MCP write policy loader
    mcpServer.ts               — MCP tool registration/handlers (Section 2.9 / Section 10)
    idlRegistry.ts               — program-ID-to-IDL mapping + Borsh decode helpers (used by
                                  decode.ts and logs.ts; extend REGISTRY for new programs,
                                  or use --idl <path> at runtime for ad-hoc decoding)
    cookieMcpClient.ts            — lazy singleton client for cookie-mcp (see Section 10.7)
    git.ts                     — checkout/restore helpers, used by rollback and prove
    wallet.ts                    — loadLocalWallet(), shared between login.ts and other commands
    anchorProject.ts               — resolveProgramIdFromAnchorProject(), shared program-ID
                                    resolution logic
    banner.ts                      — cookie ASCII banner (skipped for mcp / --ci / --json / non-TTY)
    errors.ts, logger.ts             — friendly-error formatting, --ci/--json-aware output
idl/
  recipe_book.json                    — hand-written IDL, see Section 2.2
anchor/
  programs/recipe_book/src/lib.rs      — the Recipe Book Anchor program
  Anchor.toml                          — [provider] section must stay populated (cluster=localnet,
                                        wallet path) — anchor test reads this automatically; do not
                                        rely on manually exported env vars as the normal path
```

### 3.1 Why `@solana/web3.js` v1, not v2
`@coral-xyz/anchor` (used throughout `recipeBook.ts`) is **only**
compatible with the classic v1 API (`Connection`, `PublicKey`, `Keypair`
classes). It does not support v2's `createSolanaRpc()`-style client at
all. The whole project was migrated to v1 for this reason — **do not
reintroduce any v2 API usage anywhere**, even in code that doesn't touch
Anchor directly, to keep the codebase consistent.

---

## 4. Recipe Book program details

- Program ID: `56Vj61zFW4hHV6wdjnisrHtVwWDqyjixjpBgnoRJvzxL`
- Deployed and tested on local validator (6/6 Anchor tests passing)
- Accounts: `RecipeBook` (PDA per target program, seeds
  `["recipe_book", target_program_id]`), `Entry` (PDA per deploy, seeds
  `["entry", recipe_book_pda, entry_index_le_bytes]`)
- Instructions: `initialize_recipe_book(programId)`,
  `register_deploy(repo, commit, buildHash, buffer)`
- Errors: `RecipeBookAlreadyExists`, `Unauthorized`, `StringTooLong`
- **If you change `lib.rs`**: the program ID will change on rebuild unless
  you explicitly preserve `target/deploy/recipe_book-keypair.json`. If IDs
  drift, run `anchor keys sync` then rebuild — this has happened multiple
  times during development and is a normal, known, fixable event, not a
  crisis. Update the program ID everywhere it's referenced (this file,
  `src/idl/recipe_book.json`'s `address` field, deploy configs) if it
  genuinely changes.

---

## 5. Confirmed external API details (do not guess at others)

**CookieScan (`api.cookiescan.io`)** — no auth required, CORS open.
- DAS (JSON-RPC 2.0, POST to `/`): `getAsset`, `getAssets`,
  `getAssetsByOwner`, `getAssetsByGroup`, `getAssetsByCreator`,
  `getAssetsByAuthority`, `searchAssets`, `getAssetProof`,
  `getTokenAccounts`, `getNftEditions`, `getSignaturesForAsset`,
  `getPriorityFeeEstimate` — this is a **token/NFT** API, not program
  analytics.
- REST helpers: `GET /api/status`, `/api/price/:mint`, `/api/tokens`,
  `/api/tokens/search`, `/api/markets`, `/api/markets/:mint`, `/api/cook`,
  `/v1/assets*`
- **CookieScan has NO program-invocation-analytics endpoint.** Program
  stats (`bake stats`) are computed from standard Cookie Chain RPC calls
  (`getSignaturesForAddress` + `getTransaction`), with CookieScan's REST
  API only supplying supplementary network/price context. Do not build
  or assume a CookieScan endpoint for program call counts/error
  rates/CU — it doesn't exist as of this writing. If you need to check
  again, ask before assuming.

---

## 6. Known failure signatures (don't re-diagnose from scratch — check here first)

| Symptom | Real cause | Fix |
|---|---|---|
| `Failed to parse ELF file: invalid file header` | Default build targets SBPF v3, validator can't run it | `anchor build --arch v0 --tools-version v1.57` |
| `Program is not deployed` / `Unsupported program id` on fresh `anchor test` | Known Anchor bug: test suite can start before `--validator legacy` finishes booting | Run validator, build, and deploy as 3 separate manual steps; `anchor test --skip-local-validator --skip-deploy` |
| `Upgrade authority mismatch` | Stale/leftover validator ledger from a previous session | `solana-test-validator --reset`, or find+kill orphaned validator process and delete `.anchor/test-ledger` |
| `esbuild` platform mismatch error | `node_modules` installed on the wrong OS (Windows vs WSL) | Delete `node_modules`+`package-lock.json`, reinstall from the environment that will run it |
| `ANCHOR_PROVIDER_URL is not defined` despite `Anchor.toml` looking correct | Windows/WSL PATH interop — WSL silently invoked the Windows-side `node`/`npm` instead of the Linux one | Check `which node`/`which npx` inside WSL; if they resolve to `/mnt/c/...`, disable interop in `/etc/wsl.conf` (`appendWindowsPath = false`), `wsl --shutdown`, retry |
| `error[E0432]: unresolved import 'crate'` at `#[program]` macro | Anchor version mismatch (anchor-cli vs anchor-lang / generated client module paths after a major Anchor version bump) | Confirm `anchor-lang` version in `Cargo.toml` matches installed `anchor-cli` exactly; may need re-exporting generated client account modules at crate scope for post-1.0 Anchor |
| `librustc_driver-*.so: cannot open shared object file` | Corrupted/partial platform-tools cache from an interrupted download | `rm -rf ~/.cache/solana/<version>`, let it redownload fully, uninterrupted |
| Deploy retries into a stale buffer, fails oddly | `anchor deploy` auto-resumes into a leftover upgrade-buffer from an earlier failed attempt | `solana program close <buffer-address>`, delete the local `*-upgrade-buffer.json`, redeploy fresh |

---

## 7. Coding conventions

- Every command supports `--ci` (disables spinners/colors, forces
  JSON-safe plain output) and `--json` (structured output, no decorative
  text). Preserve this on every new command.
- Friendly errors go through `src/lib/errors.ts` helpers — never let a raw
  stack trace reach the user for expected failure modes (missing
  Anchor.toml, out-of-range index, dirty git tree, etc.). Unexpected
  underlying tool errors (anchor/git/cargo output) should still be shown
  in full for debugging, just wrapped with a friendly headline first.
- Long-running/destructive operations (rollback, prove --rebuild) prompt
  for confirmation unless `--yes`/`-y`, `--ci`, or `--json` is passed.
- Mock escape hatches (`BAKE_MOCK_RECIPE_BOOK=1`) exist for testing
  command orchestration without touching a real chain — preserve this
  pattern for any new on-chain-dependent command.

---

## 8. Hackathon compliance — do not let feature work break these

- **Must be built on Cookie Chain (SVM)** — Cookie Chain must stay the
  primary, headline target in all messaging, even as multi-SVM support is
  demonstrated as a secondary strength. Don't let README/pitch language
  drift toward "chain-agnostic tool" as the primary framing.
- **Cookiebox/Cookieswap/Cookie DAS/cookie-mcp integrations are
  "encouraged," not required** — `bake stats`'s CookieScan REST usage
  already satisfies part of this.
- **Source code must be open source** — repo is public at
  github.com/DiverseXL/bake. Keep it that way; don't accidentally make it
  private.
- **Application must be deployed and publicly accessible** — for a CLI,
  this means: published to npm publicly, AND the Recipe Book program
  actually deployed to real Cookie Chain mainnet (not just local
  validator) with its address verifiable on CookieScan's public explorer.
  **As of this writing, Recipe Book has only been deployed to a local
  validator — the real mainnet deploy is still pending on wallet
  funding.** Do not consider the submission compliance-ready until this
  is done.

---

## 9. Before you "fix" something that looks weird

If you're an agent reading this mid-task and about to change a flag,
delete a fallback, or "simplify" something that looks redundant —
**stop and check the section above first.** Nearly everything unusual in
this codebase (specific build flags, dual IDL sources, the WSL relay,
try/finally git restores, v1-only web3.js) exists because of a real,
previously-diagnosed failure. Re-breaking a fixed problem costs more time
than reading this file.

---

## 10. MCP safety model — `bake mcp`

`bake mcp` starts a local stdio-based MCP server (`@modelcontextprotocol/sdk`
with `StdioServerTransport`) that exposes bake's capabilities to AI agents.
This is the one command that lets an agent trigger real on-chain writes, so
the safety model is the core design, not an afterthought.

### 10.1 Two tiers of tools

**Read-only tools** (always registered, no policy needed):
- `bake_whoami` — active wallet(s) + cluster
- `bake_stats` — program activity stats (reuses `collectProgramStats()` from stats.ts)
- `bake_prove` — Level 1 on-chain hash check only (NOT `--rebuild`, which touches git state)
- `bake_logs` — recent log history only (NOT `--follow`, which streams indefinitely)
- `bake_get_history` — Recipe Book entries for a program

**Write/destructive tools** (disabled by default, require explicit policy):
- `bake_deploy` — reuses `runDeployPipeline()` from deployPipeline.ts
- `bake_rollback` — reuses `runRollbackPipeline()` from rollbackPipeline.ts
- `bake_confirm_action` — executes a previously previewed write using a confirmation token

### 10.2 Policy file

`bake mcp --policy <path>` or auto-discovered at `.bake/mcp-policy.json`.
Validated with Zod (see `src/lib/mcpPolicy.ts`). Schema:

```json
{
  "allowWrites": false,
  "allowedPrograms": "any",
  "maxDeploysPerSession": 5,
  "requireConfirmation": true
}
```

Without a policy file, `bake mcp` starts in READ-ONLY mode. Write tools
are **not registered at all** — not "registered but blocked." An agent
cannot be tricked into calling a tool it does not know exists.

### 10.3 Confirmation-token flow (requireConfirmation: true)

When `requireConfirmation` is true (the default), write tools do NOT
execute immediately. Instead:

1. Agent calls `bake_deploy` or `bake_rollback`
2. Server returns `status: "confirmation_required"` with a preview of what
   would happen (program, commit, cluster, estimated cost) and a
   `confirmationToken` (random hex, 5-minute TTL)
3. Agent (or human) calls `bake_confirm_action` with that token
4. Server executes the action and returns the result

This is the human-in-the-loop safety net — a real deploy cannot complete
in a single unsupervised tool call when `requireConfirmation` is true.

### 10.4 Session deploy counter

The MCP server process tracks how many writes have been executed in its
lifetime. Once `maxDeploysPerSession` is hit, all further write calls
are refused with a clear error explaining why (not a silent failure).
The counter resets only when the MCP server process is restarted.

### 10.5 Audit logging

Every write tool call (attempted or executed, allowed or refused) is
logged to stderr with an ISO timestamp. Stdout is reserved for the MCP
protocol itself. The startup summary on stderr shows mode, policy file
location, and resolved policy values so a human watching the terminal
always knows what an agent is allowed to do.

### 10.6 Implementation files

- `src/commands/mcp.ts` — command entrypoint, loads policy, starts server
- `src/lib/mcpServer.ts` — tool definitions, handlers, confirmation tokens, audit log
- `src/lib/mcpPolicy.ts` — Zod-validated policy schema and loader
- `src/lib/cookieMcpClient.ts` — lazy singleton client for cookie-mcp (see 10.7)

### 10.7 cookie-mcp integration (`bake_check_token_liquidity`)

`bake_check_token_liquidity` spawns the official `cookie-mcp` npm package as
an **isolated child MCP process** for read-only token/liquidity lookups
(price, pools, launchpad status). Key design constraints:

- **Stdio isolation**: cookie-mcp's child-process stdio streams are piped
  (never inherited) — bake's own MCP server also communicates over stdio with
  whatever agent is calling it. Mixing these would corrupt both MCP protocols.
  The `StdioClientTransport` spawns its own process with `stdio: ['pipe','pipe','pipe']`.
- **No wallet**: `COOKIE_PRIVATE_KEY` is **never** set in the spawn env.
  Only `COOKIE_RPC_URL` is passed. This integration is strictly read-only.
- **Lazy singleton**: cookie-mcp is only spawned the first time the tool is
  called (not on `bake mcp` startup) — avoids overhead/download delay for
  sessions that never use this feature.
- **Node version gate**: Checks `node --version >= 22` before spawning.
  Fails with a clear message if the running Node is too old.
- **Cleanup**: The child process is terminated when bake's MCP server exits.

### 10.8 `bake fork` — clone a program into a local validator

`bake fork <programId>` clones a real on-chain program (and optionally its
accounts) from any source cluster into a fresh `solana-test-validator`, so
you can rehearse changes against real state for free.

**Source resolution**: `--source <cluster>` accepts a known preset name
(`mainnet`, `devnet`, `cookie`) or a full RPC URL. Defaults to Solana
mainnet (`https://api.mainnet-beta.solana.com`).

**Pre-flight validation**: Before spawning the validator, the command:
1. Resolves and validates the source RPC (sends `getGenesisHash`, fails
   with a friendly error if unreachable/timed out).
2. Optionally calls `getProgramAccounts` (opt-in via
   `--fetch-program-accounts`) to clone a sample of the program's accounts.
3. Prints a summary of what will be cloned, then spawns the validator in
   the foreground with live stdout/stderr streaming.

**`getProgramAccounts` caveat (KNOWN CONSTRAINT, not a bug)**:
Free public Solana RPCs (`api.mainnet-beta.solana.com`) commonly reject
or rate-limit `getProgramAccounts` calls. When this happens, `bake fork`
prints a **warning** (not a fatal error) and falls back to cloning only
the bare program + any explicitly listed `--accounts`. Do NOT "fix" this
by retrying aggressively — a public RPC that rejects GPA will never allow
it regardless of retries. The fix is either: (a) use a paid RPC provider
via `--source <url>`, or (b) omit `--fetch-program-accounts` and list
specific accounts manually via `--accounts`.

**Foreground execution**: The validator runs as a foreground process with
live-streamed output (via `spawnToolchainForeground` in toolchain.ts).
It stays alive until the user presses Ctrl+C. On Windows, it is relayed
through WSL (same as all other toolchain commands).

**Port handling**: Defaults to port 8899. If the port is already in use
(another validator is running), the command detects the non-zero exit and
suggests `--port` or stopping the existing validator.

**WSL2 resource exhaustion (KNOWN CONSTRAINT, not a bug)**:
Repeated or rapid `bake fork` invocations (starting multiple validators
in quick succession without cleanly stopping the previous one) can exhaust
WSL2 memory/CPU resources and crash the WSL instance itself (observed
during testing — WSL becomes unresponsive, `wsl --shutdown` required).
Do NOT "fix" this by adding retry/resilience logic. The correct mitigation
is: fully stop one fork's validator (Ctrl+C, confirm clean shutdown)
before starting another. If WSL crashes, run `wsl --shutdown` from
PowerShell, wait a few seconds, then restart.

### 10.9 Docker toolchain (`bake-toolchain` image)

A `Dockerfile` at the repo root packages the full, known-working
Anchor/Solana toolchain into a container image. This is an **alternative to
the WSL relay** for running Anchor commands directly — it does NOT replace
bake's own WSL auto-relay for end-users running `bake deploy` on Windows.

**Use cases:**
- (a) Testing bake on machines without WSL set up (e.g. a friend's laptop)
- (b) Reproducible CI-style builds
- (c) Contributors who prefer not to install the toolchain natively

**Pinned versions (do not change without re-verifying):**
- Rust: 1.89.0 (base image `rust:1.89.0-slim-trixie` — matches the project's pinned toolchain in `anchor/rust-toolchain.toml`, so Anchor's host-side IDL generation needs no runtime rustup download. Trixie's glibc 2.41 is required: the anchor-cli prebuilt links against glibc >= 2.39 — bookworm's 2.36 fails with `GLIBC_2.39 not found`; do not downgrade)
- Solana/Agave CLI: 3.1.10 (Anza installer, pinned URL)
- Anchor CLI: 1.2.0 — downloaded as the PREBUILT release binary
  (`anchor-1.2.0-x86_64-unknown-linux-gnu`) with a pinned sha256 check.
  **Do NOT switch this back to avm**: avm has no prebuilt binary, so
  installing it means compiling sigstore-verify → reqwest/rustls →
  aws-lc-sys (BoringSSL) from source — 15-30 min per fresh image build, for
  the identical artifact.  (It's also why the base was briefly rust:1.91.)
- Node.js: 22.x (via NodeSource, satisfies cookie-mcp >=22 requirement)
- Platform tools: v1.57 (pre-warmed during image build)
- Dev wallet: `~/.config/solana/id.json` generated during build (Anchor.toml's provider wallet; funded by the local validator's faucet)

**Pre-warm note:** `cargo-build-sbf --version` exits before any download, so the
image pre-warms platform-tools by actually running `cargo-build-sbf
--tools-version v1.57` on a throwaway empty cdylib crate during `docker
build` — the real build invocation is what populates `~/.cache/solana/v1.57`.
Do not "simplify" this back to `--version`; it silently stops pre-warming.

**Run command:**
```bash
docker run --rm -v "${PWD}:/workspace" -w /workspace/anchor bake-toolchain \
    anchor build --arch v0 --tools-version v1.57
```

Or via docker-compose:
```bash
docker compose run --rm toolchain anchor build --arch v0 --tools-version v1.57
docker compose run --rm toolchain anchor test --validator legacy
docker compose run --rm toolchain bash   # interactive shell
```

**Key design choices:**
- The Anchor project directory is mounted as a volume, not COPYed — code
  changes on the host are reflected immediately without rebuilding the image.
- All tool paths are baked into the image's ENV — no `source ~/.cargo/env`
  or profile-sourcing needed at container runtime.
- Platform-tools v1.57 is pre-warmed during `docker build` so the first
  `anchor build` in the container doesn't trigger a network download.

---

## 11. Security audit backlog (2026-09-09)

The following items were identified during a comprehensive security +
error-handling audit. Critical/High items were fixed in-session; Medium/Low
are backlog for future work.

### Fixed

| Finding | Severity | Fix |
|---------|----------|-----|
| `deploy.ts` had no confirmation prompt before on-chain deploy | HIGH | Added `--yes`/`--ci`/`--json` gating + interactive `y/N` prompt |
| WSL relay env var key names not shell-quoted in `toolchain.ts` | MEDIUM | Quoted key via `shellQuote(key)` |
| `readGlobalConfig()` / `readProjectConfig()` silently return `null` on corrupted JSON | LOW | Added stderr warning before returning null |

### Backlog (Medium/Low)

| Finding | Severity | Notes |
|---------|----------|-------|
| `prove.ts --rebuild` has no confirmation prompt before git checkout | LOW | Mitigated by clean-tree requirement + `finally` restore |
| `config.json` written without `chmod 0o600` (unlike keypair.json) | LOW | Low risk on single-user machines |
| `writeGlobalConfig()` uses non-atomic `writeFileSync` | LOW | Single-user CLI; unsafe only in concurrent CI |
| No pre-flight RPC check in `bake deploy` | LOW | User waits for full build to fail if RPC is down |
| No pre-flight balance check before deploy/rollback | LOW | Raw Solana CLI error shown; could be friendlier |
| `cookieMcpClient.ts` hardcodes `CLUSTERS.cookie.endpoint` | LOW | Ignores user's active cluster |
| `npm audit` — `bigint-buffer` (high), `toml` (high), `uuid` (moderate), `stream-json` (moderate) | LOW | Transitive deps via `@solana/web3.js` + `@coral-xyz/anchor`; no fix without major version bump |