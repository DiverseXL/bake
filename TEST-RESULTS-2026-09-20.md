# bake Session & Agent Init — Stress Test Results

**Date:** 2026-09-20
**Version:** 0.4.0
**Environment:** Windows (Git Bash) + WSL2 Ubuntu, Solana CLI 3.1.10, Anchor CLI via WSL
**Tester:** Buffy (Codebuff AI agent)

---

## Summary

| Feature | Verdict | Notes |
|---------|---------|-------|
| `bake session open` (with validator) | **❌ BLOCKED** | WSL `bash -lc` hangs due to `.profile` nvm sourcing |
| `bake session open --no-validator` | **✅ PASS** | Works correctly |
| `bake session status` | **✅ PASS** | Detects dead PIDs, updates metadata |
| `bake session close --yes` | **✅ PASS** | Cleans up session dir and pointer |
| `bake session open --force` | **✅ PASS** | Closes existing session before opening new one |
| Crash recovery (stale pointer) | **✅ PASS** | Auto-cleans invalid meta.json pointers |
| Crash recovery (dead PID) | **✅ PASS** | Detects dead validator PID, updates status |
| Config restoration (valid JSON) | **⚠ PARTIAL** | `walletPath` preserved; `name` normalized (expected) |
| Config restoration (corrupted JSON) | **❌ BUG** | Silent data loss when config has invalid JSON |
| `bake agent init` scaffolding | **✅ PASS** | All 7 files generated correctly |
| MCP read-only tools | **✅ PASS** | 6 tools registered, all functional |
| MCP write tool gating | **✅ PASS** | Write tools hidden when `allowWrites: false` |
| MCP `bake_whoami` integration | **✅ PASS** | Returns correct cluster, RPC, wallet |

---

## PART 1 — bake Session: Real Validator Lifecycle

### 1.1 `bake session open` with Real Validator

**Result: ❌ BLOCKED — WSL `bash -lc` hang**

**Root Cause:** The user's WSL `~/.profile` sources `nvm.sh` at the bottom:
```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use --silent default >/dev/null 2>&1
```

When `startValidator()` in `session.ts` spawns:
```bash
wsl -d Ubuntu -e bash -lc 'source "$HOME/.cargo/env" 2>/dev/null; source "$HOME/.nvm/nvm.sh" 2>/dev/null; export PATH="..."; solana-test-validator ...'
```

The `-lc` flag triggers a login shell, which sources `~/.profile`, which sources `nvm.sh` — and this hangs indefinitely in non-interactive mode.

**Evidence:**
```
$ timeout 5 bash -lc "export NVM_DIR=\$HOME/.nvm; . \"\$NVM_DIR/nvm.sh\"; echo ok"
exit=124  # killed by timeout — nvm.sh hung

$ timeout 10 bash -c "source \$HOME/.nvm/nvm.sh 2>/dev/null; export PATH=...; solana-test-validator --version"
solana-test-validator 3.1.10  # works fine with -c (non-login)
```

**Impact:** `bake session open` hangs for 90+ seconds (the `waitForValidator` timeout) before timing out. The session metadata is created with `validatorRunning: true` but the validator never starts. The validator.log file is 0 bytes.

**Proposed Fix:** In `session.ts:startValidator()`, change `bash -lc` to `bash -c` in the Windows WSL branch. The inner command already explicitly sources `.cargo/env` and sets the PATH, so the login shell's profile sourcing is redundant and harmful.

**Note:** This is an environment-specific issue — it depends on what the user has in `~/.profile`. Users without nvm sourcing in `.profile` would not be affected. However, the `startValidator` inner command should not depend on profile behavior since it explicitly sources everything it needs.

### 1.2 `bake session deploy` into Session Validator

**Result: ❌ BLOCKED (depends on 1.1)**

Without a running validator, `session deploy` cannot complete. The deploy pipeline calls `anchor deploy` which needs a live RPC endpoint. Previous test runs showed it attempting to deploy to `http://127.0.0.1:8899` and failing after multiple retry attempts.

The deploy pipeline itself (build → deploy → hash → register) was not testable in this session due to the validator not running.

### 1.3 `bake session close --yes`

**Result: ✅ PASS**

Session close correctly:
1. Calls `stopValidator(meta.validatorPid)` — returns immediately when PID is null
2. Calls `rmSync(dir, { recursive: true, force: true })` to delete session directory
3. Clears the `current` pointer file

```bash
$ node dist/index.js session close --yes
✔ Session sess_mu9neagx_80g2ox closed.
  Ephemeral keypair deleted.

$ cat ~/.bake/sessions/current  # No such file or directory — clean
```

**Edge case observed:** When the validator was still in the process of starting (WSL relay process alive but validator inside WSL dead), `session close` took slightly longer due to the `pkill -f solana-test-validator` call on Windows (5s timeout). This is acceptable.

### 1.4 Crash Recovery Simulation

**Result: ✅ PASS (all sub-tests)**

#### Test A: Stale Pointer Cleanup

Created a session, deleted the session directory while keeping the `current` pointer file (simulating a process kill):

```bash
$ rm -rf ~/.bake/sessions/sess_crash_test_123  # Delete session dir
$ cat ~/.bake/sessions/current                   # Pointer still exists
sess_crash_test_123
$ node dist/index.js session status              # Detects stale pointer
No active session. Run `bake session open` to create one.
```

**Verdict:** `getActiveSessionId()` correctly detects when the session directory is missing and cleans up the stale pointer. This prevents the "ghost session" problem.

#### Test B: Dead PID Detection

Created a session with a fake validator PID (99999) that doesn't exist:

```json
{
  "validatorPid": 99999,
  "validatorRunning": true
}
```

```bash
$ node dist/index.js session status
  Active session
  ...
  Validator:   not running    # Correctly detected dead PID

$ # Verify meta was updated
$ node -e "...meta.json..."
pid: null running: false      # Updated to reflect reality
```

**Verdict:** `updateValidatorStatus()` correctly detects dead PIDs via `process.kill(pid, 0)` and updates the metadata. The session remains accessible (not treated as stale) — the status correctly reports the validator as "not running."

#### Test C: `--force` Session Replacement

```bash
$ node dist/index.js session open --no-validator --yes --force
Closing existing session sess_crash_test_123 (--force)...
✔ Session opened: sess_mu9neagx_80g2ox
```

**Verdict:** `--force` correctly closes the existing session (calls `closeSession()`) before opening a new one. The old session directory is deleted and the pointer is updated.

---

## PART 2 — Config Restoration Verification

### Test Setup

Snapshot of `~/.bake/config.json` before the session cycle:

```json
{
  "cluster": "cookie",
  "activeCluster": {
    "name": "Cookie Chain",
    "rpcUrl": "https://rpc.cookiescan.io"
  },
  "walletPath": "C:\\Users\\MY PC\\.bake\\keypair.json"
}
```

### Test: `bake use cookie` → `session open` → `session close`

**Result: ⚠ CONFIG MODIFIED (partially expected, partially bug)**

After the cycle:
```json
{
  "cluster": "cookie",
  "activeCluster": {
    "name": "cookie",
    "rpcUrl": "https://rpc.cookiescan.io"
  },
  "walletPath": "C:\\Users\\MY PC\\.bake\\keypair.json"
}
```

**Changes:**
1. `"name": "Cookie Chain"` → `"name": "cookie"` — **Expected.** The `CLUSTERS["cookie"]` preset defines `name: "cookie"`, not `"Cookie Chain"`. `bake use` normalizes to the preset name.
2. `walletPath` preserved — **✅ PASS.** With valid JSON config, the field survives the read-modify-write cycle.
3. Trailing newline removed — **Cosmetic.** `JSON.stringify()` doesn't add trailing newlines.

**Conclusion:** `bake use` + session commands do NOT corrupt a valid config file. The session commands do not touch global config (they use process-local env vars via `buildSessionDeployEnv()`).

### Bug: Corrupted Config Causes Silent Data Loss

**Result: ❌ BUG (defensive coding gap)**

When the config file contains invalid JSON (e.g., unescaped backslashes from manual editing), the following happens:

```
Warning: ignoring corrupted global config: Bad escaped character in JSON
```

1. `readGlobalConfig()` catches the parse error, returns `null`
2. `updateGlobalConfig()` starts with `const current = null ?? {}` → empty object
3. Mutator sets `data.activeCluster = { name, rpcUrl }`
4. `writeGlobalConfigFile()` writes back **only the cluster info**
5. All other fields (`walletPath`, `nightlyWallet`, `preferences`, etc.) are **silently lost**

**This is a data-loss scenario.** A user who manually edits their config and introduces a typo could lose their wallet path and other settings without any backup.

**Proposed Fix:** When `readGlobalConfig()` returns `null` (corrupted config), `updateGlobalConfig()` should:
1. Back up the corrupted file to `config.json.corrupted.<timestamp>`
2. Log a clear warning: "Backing up corrupted config to ..."
3. Write the new config from scratch
4. Optionally refuse to write if the corruption wasn't recently introduced

---

## PART 3 — `bake agent init` Integration Test

### 3.1 Scaffolding

**Result: ✅ PASS**

```bash
$ node dist/index.js agent init test-agent --yes
✔ Scaffolded agent project at C:\Users\MY PC\Documents\bake\test-agent

  create policy.example.json
  create package.json
  create .gitignore
  create prompts/system.md
  create mcp/mcp.json
  create mcp/README.md
  create README.md
```

All 7 files generated. Contents verified:

| File | Content | Status |
|------|---------|--------|
| `policy.example.json` | `allowWrites: false`, `requireConfirmation: true` | ✅ |
| `package.json` | Name matches, has `mcp:bake` script | ✅ |
| `.gitignore` | Ignores `.env`, `node_modules`, keypairs, `.bake/` | ✅ |
| `mcp/mcp.json` | Points to `bake mcp --policy ./policy.example.json` + cookie-mcp | ✅ |
| `mcp/README.md` | Documents Cursor, Claude Desktop, other editor wiring | ✅ |
| `prompts/system.md` | Agent rules for read-only tools, write gating | ✅ |
| `README.md` | Prerequisites, quick start, policy reference | ✅ |

### 3.2 MCP Client Integration Test

**Result: ✅ ALL PASS**

Spawned the generated MCP config as a real stdio MCP server and tested JSON-RPC protocol:

| Test | Result | Details |
|------|--------|---------|
| `initialize` | ✅ | Server responded: `name=bake`, `version=0.4.0` |
| `tools/list` | ✅ | 6 tools returned: `bake_whoami`, `bake_stats`, `bake_prove`, `bake_logs`, `bake_get_history`, `bake_check_token_liquidity` |
| No write tools | ✅ | `bake_deploy`, `bake_rollback`, `bake_confirm_action` NOT in tool list |
| `bake_whoami` | ✅ | Returns `cluster=cookie`, `rpcUrl=https://rpc.cookiescan.io`, `localWallet=C:\...\keypair.json` |
| `bake_deploy` rejected | ✅ | Returns MCP error -32602: "Tool bake_deploy not found" |
| Audit log | ✅ | stderr shows: Mode=READ-ONLY, Policy loaded, Write tools NOT registered |
| Clean shutdown | ✅ | SIGTERM terminates server gracefully |

**The generated MCP config produces a fully working, read-only MCP connection to bake.** An AI agent using this config would see only safe, read-only tools and could not accidentally trigger on-chain writes.

---

## Bugs Found

### BUG-1: WSL `bash -lc` hang in `startValidator` (HIGH)

- **File:** `src/lib/session.ts`, `startValidator()` Windows branch
- **Impact:** `bake session open` (with validator) hangs indefinitely on systems where `~/.profile` sources nvm or other interactive-only tools
- **Fix:** Change `bash -lc` to `bash -c` in the WSL spawn command; the inner command already sources all needed environment
- **Severity:** HIGH — blocks the core session workflow on affected systems

### BUG-2: Corrupted config causes silent data loss (MEDIUM)

- **File:** `src/config/index.ts`, `updateGlobalConfig()`
- **Impact:** If `~/.bake/config.json` has invalid JSON (from manual editing, crash during write, etc.), `bake use` silently overwrites it with only the cluster info, losing `walletPath`, `nightlyWallet`, `preferences`, etc.
- **Fix:** Backup corrupted config before overwriting; log a clear warning
- **Severity:** MEDIUM — requires pre-existing config corruption to trigger, but the data loss is silent and irreversible

### BUG-3 (pre-existing): Config corruption from previous session (INFO)

- **File:** `~/.bake/config.json` at session start
- **State:** Config had `"rpcUrl": "http://127.0.0.1:9"` (truncated URL) and `"name": "custom"` — likely from the previous `bake session deploy` attempt that targeted the wrong RPC
- **Impact:** `bake use cookie` would have silently overwritten this corrupted config per BUG-2
- **Note:** This was the pre-existing state at session start, not introduced by current tests

---

## Recommendations

1. **Fix BUG-1 immediately** — Change `bash -lc` to `bash -c` in `startValidator()` Windows branch. This is a one-line fix that unblocks `bake session open` for all users with nvm in their profile.

2. **Add config backup before overwrite** — Before `writeGlobalConfigFile()` writes, check if the existing file parses. If not, copy it to `config.json.corrupted.<timestamp>` and log the backup path.

3. **Consider adding `--force` to `session close`** — The current `session close` can hang if the WSL `pkill` command takes time. A `--no-validator-check` flag could skip the pkill for faster cleanup in non-validator sessions.

4. **Session deploy timeout** — The `anchor build` via WSL can take 60-120+ seconds. Consider a longer default timeout or a `--timeout` flag for session deploy.

---

## Raw Evidence Log

All commands were run from `C:\Users\MY PC\Documents\bake` (project root). WSL commands used `wsl -d Ubuntu -e bash -c '...'` with `MSYS_NO_PATHCONV=1` to avoid Git Bash path mangling.

Key timestamps:
- Session cleanup: 2026-09-20T09:26Z
- First session open (hangs): 2026-09-20T09:30Z
- NVM hang diagnosis: 2026-09-20T09:35Z
- Crash simulation tests: 2026-09-20T09:56Z–10:05Z
- Config restoration tests: 2026-09-20T10:05Z–10:10Z
- Agent init + MCP test: 2026-09-20T10:14Z–10:16Z
