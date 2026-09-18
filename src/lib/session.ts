/**
 * Session state management — disposable local deploy workspaces.
 *
 * Stores session metadata + ephemeral keypair under ~/.bake/sessions/<id>/,
 * with a "current" pointer file for the active session.
 *
 * Does NOT touch the user's global config (activeCluster / walletPath).
 * Connection/wallet overrides are process-local via env vars.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair } from "@solana/web3.js";
import { getGlobalConfigDir } from "../config/index.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMeta {
  id: string;
  createdAt: string;
  workspaceDir: string;
  keypairPath: string;
  publicKey: string;
  rpcUrl: string;
  rpcPort: number;
  validatorPid: number | null;
  validatorRunning: boolean;
  clusterLabel: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SESSIONS_DIR = join(getGlobalConfigDir(), "sessions");

function sessionDir(sessionId: string): string {
  return join(SESSIONS_DIR, sessionId);
}

function sessionMetaPath(sessionId: string): string {
  return join(sessionDir(sessionId), "meta.json");
}

function sessionKeypairPath(sessionId: string): string {
  return join(sessionDir(sessionId), "keypair.json");
}

function currentPointerPath(): string {
  return join(SESSIONS_DIR, "current");
}

// ---------------------------------------------------------------------------
// Current pointer
// ---------------------------------------------------------------------------

export function getActiveSessionId(): string | null {
  const ptr = currentPointerPath();
  if (!existsSync(ptr)) return null;
  try {
    const id = readFileSync(ptr, "utf-8").trim();
    if (!id) return null;
    // Verify the session dir actually exists
    if (!existsSync(sessionMetaPath(id))) {
      // Stale pointer — clean up
      try { unlinkSync(ptr); } catch { /* best effort */ }
      return null;
    }
    return id;
  } catch {
    return null;
  }
}

function setActiveSessionId(sessionId: string): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
  writeFileSync(currentPointerPath(), sessionId, "utf-8");
}

function clearActiveSessionId(): void {
  const ptr = currentPointerPath();
  if (existsSync(ptr)) {
    try { unlinkSync(ptr); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Session ID generation
// ---------------------------------------------------------------------------

function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `sess_${ts}_${rand}`;
}

// ---------------------------------------------------------------------------
// Keypair generation (ephemeral — no persistence to global config)
// ---------------------------------------------------------------------------

function createEphemeralKeypair(sessionId: string): {
  keypairPath: string;
  publicKey: string;
} {
  const dir = sessionDir(sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pubKey = ed25519.getPublicKey(seed);
  const keypairBytes = new Uint8Array(64);
  keypairBytes.set(seed, 0);
  keypairBytes.set(pubKey, 32);

  const kpPath = join(dir, "keypair.json");
  writeFileSync(kpPath, JSON.stringify(Array.from(keypairBytes)), "utf-8");
  try {
    chmodSync(kpPath, 0o600);
  } catch {
    // Windows doesn't support chmod; ignore silently.
  }

  const publicKey = Keypair.fromSecretKey(keypairBytes).publicKey.toBase58();
  return { keypairPath: kpPath, publicKey };
}

// ---------------------------------------------------------------------------
// Metadata read/write
// ---------------------------------------------------------------------------

export function loadSessionMeta(sessionId: string): SessionMeta | null {
  const path = sessionMetaPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return raw as SessionMeta;
  } catch {
    return null;
  }
}

function saveSessionMeta(meta: SessionMeta): void {
  const dir = sessionDir(meta.id);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(sessionMetaPath(meta.id), JSON.stringify(meta, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// PID / process checks
// ---------------------------------------------------------------------------

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0: doesn't send a signal, but checks if the process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function updateValidatorStatus(meta: SessionMeta): SessionMeta {
  if (meta.validatorPid != null && meta.validatorRunning) {
    const alive = isProcessAlive(meta.validatorPid);
    if (!alive) {
      meta.validatorRunning = false;
      meta.validatorPid = null;
      saveSessionMeta(meta);
    }
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Validator lifecycle
// ---------------------------------------------------------------------------

interface ValidatorStartResult {
  pid: number;
}

/**
 * Start solana-test-validator as a background (detached) process.
 * Returns the PID so the session can track it.
 *
 * On Windows this goes through WSL relay automatically via spawnToolchainForeground,
 * but since we need background mode (non-blocking), we use spawn directly
 * with detached: true and a log file.
 */
export async function startValidator(
  port: number,
  ledgerDir: string,
): Promise<ValidatorStartResult> {
  const logPath = join(ledgerDir, "validator.log");
  const ledgerPath = join(ledgerDir, "ledger");

  // Ensure ledger directory exists
  if (!existsSync(ledgerDir)) {
    mkdirSync(ledgerDir, { recursive: true });
  }

  if (process.platform !== "win32") {
    // Native: spawn detached with stdio redirected to log file
    const child = spawn(
      "solana-test-validator",
      [
        "--reset",
        "--rpc-port",
        String(port),
        "--faucet-sol",
        "0",
        "--ledger",
        ledgerPath,
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      },
    );

    if (child.pid) {
      // Write PID to a file for recovery after process restart
      writeFileSync(join(ledgerDir, "validator.pid"), String(child.pid), "utf-8");
    }

    // Unref so the parent process can exit independently
    child.unref();

    // Pipe stdout/stderr to log file
    const fs = await import("node:fs");
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    if (!child.pid) {
      throw new Error("Failed to start solana-test-validator: no PID assigned");
    }

    return { pid: child.pid };
  }

  // Windows: relay through WSL with detached + background
  const { windowsPathToWsl } = await import("./toolchain.js");
  const wslLedgerDir = windowsPathToWsl(ledgerDir);

  // Build the inner command
  const innerCmd = [
    'source "$HOME/.cargo/env" 2>/dev/null',
    'source "$HOME/.nvm/nvm.sh" 2>/dev/null',
    'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"',
    `solana-test-validator --reset --rpc-port ${port} --faucet-sol 0 --ledger ${wslLedgerDir}/ledger`,
  ].join(" && ");

  const child = spawn(
    "wsl",
    ["-d", "Ubuntu", "-e", "bash", "-lc", innerCmd],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  if (child.pid) {
    writeFileSync(join(ledgerDir, "validator.pid"), String(child.pid), "utf-8");
  }

  child.unref();

  const fs = await import("node:fs");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  if (!child.pid) {
    throw new Error("Failed to start solana-test-validator via WSL: no PID assigned");
  }

  return { pid: child.pid };
}

/**
 * Wait for the validator to become healthy by polling getSlot.
 * Resolves when the RPC responds, rejects on timeout.
 */
export async function waitForValidator(
  rpcUrl: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
        signal: AbortSignal.timeout(3_000),
      });
      const body = (await res.json()) as { result?: number; error?: unknown };
      if (typeof body.result === "number") {
        return; // Validator is up
      }
      lastError = body.error ? JSON.stringify(body.error) : "unexpected response";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    // Brief backoff
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `Validator did not become healthy within ${timeoutMs / 1000}s at ${rpcUrl}` +
    (lastError ? ` (last error: ${lastError})` : ""),
  );
}

/**
 * Stop a validator by sending SIGTERM, then SIGKILL if needed.
 * Best-effort — warns if process already dead.
 */
export function stopValidator(pid: number | null): void {
  if (pid == null) return;
  try {
    if (isProcessAlive(pid)) {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Process already dead or no permission — fine
  }
}

// ---------------------------------------------------------------------------
// High-level session operations
// ---------------------------------------------------------------------------

export interface OpenSessionOpts {
  port: number;
  noValidator: boolean;
  workspaceDir: string;
}

export interface OpenSessionResult {
  meta: SessionMeta;
  keypairCreated: boolean;
}

/**
 * Create a new session. Fails if an active session already exists (unless
 * caller has already closed it).
 */
export function openSession(opts: OpenSessionOpts): OpenSessionResult {
  const existing = getActiveSessionId();
  if (existing) {
    const existingMeta = loadSessionMeta(existing);
    const label = existingMeta?.id ?? existing;
    throw new Error(
      `Active session already exists: ${label}\nRun \`bake session close\` first, or use --force.`,
    );
  }

  const id = generateSessionId();
  const dir = sessionDir(id);
  mkdirSync(dir, { recursive: true });

  // Generate ephemeral keypair
  const { keypairPath, publicKey } = createEphemeralKeypair(id);

  const meta: SessionMeta = {
    id,
    createdAt: new Date().toISOString(),
    workspaceDir: opts.workspaceDir,
    keypairPath,
    publicKey,
    rpcUrl: `http://127.0.0.1:${opts.port}`,
    rpcPort: opts.port,
    validatorPid: null,
    validatorRunning: false,
    clusterLabel: "session-local",
  };

  saveSessionMeta(meta);
  setActiveSessionId(id);

  return { meta, keypairCreated: true };
}

/**
 * Complete a session open by starting the validator and updating metadata.
 * Separated so the command can print intermediate output.
 */
export async function startSessionValidator(
  meta: SessionMeta,
): Promise<SessionMeta> {
  const ledgerDir = join(sessionDir(meta.id), "validator");
  const result = await startValidator(meta.rpcPort, ledgerDir);

  meta.validatorPid = result.pid;
  meta.validatorRunning = true;
  saveSessionMeta(meta);

  // Wait for it to be healthy
  await waitForValidator(meta.rpcUrl);

  return meta;
}

/**
 * Get the active session, updating validator status if needed.
 */
export function getActiveSession(): SessionMeta | null {
  const id = getActiveSessionId();
  if (!id) return null;
  const meta = loadSessionMeta(id);
  if (!meta) return null;
  return updateValidatorStatus(meta);
}

/**
 * Close a session: stop validator, delete session dir, clear pointer.
 * Never touches the user's Anchor project workspace.
 */
export function closeSession(
  meta: SessionMeta,
  opts: { keepWorkspace?: boolean } = {},
): void {
  // Stop validator if running
  stopValidator(meta.validatorPid);

  // Delete session directory (contains keypair, ledger, etc.)
  const dir = sessionDir(meta.id);
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort — warn but don't fail
      logger.warn(`Could not fully remove session directory: ${dir}`);
    }
  }

  // Clear current pointer
  clearActiveSessionId();
}

// ---------------------------------------------------------------------------
// Environment overrides for session deploy
// ---------------------------------------------------------------------------

/**
 * Build env vars that temporarily redirect bake's connection/wallet to the
 * session. Returns the env object to spread into process.env, plus the
 * original values to restore.
 *
 * This does NOT modify global config — only affects the current process.
 */
export function buildSessionDeployEnv(
  meta: SessionMeta,
): { env: Record<string, string>; restore: () => void } {
  // Save originals from env (set by preAction hook or user)
  const origAnchorProvider = process.env.ANCHOR_PROVIDER_URL;
  const origAnchorWallet = process.env.ANCHOR_WALLET;
  const origBakeRpcOverride = process.env.BAKE_RPC_URL;

  const env: Record<string, string> = {
    ANCHOR_PROVIDER_URL: meta.rpcUrl,
    ANCHOR_WALLET: meta.keypairPath,
    BAKE_RPC_URL: meta.rpcUrl,
  };

  const restore = () => {
    // Restore originals (or delete if they weren't set)
    if (origAnchorProvider !== undefined) {
      process.env.ANCHOR_PROVIDER_URL = origAnchorProvider;
    } else {
      delete process.env.ANCHOR_PROVIDER_URL;
    }
    if (origAnchorWallet !== undefined) {
      process.env.ANCHOR_WALLET = origAnchorWallet;
    } else {
      delete process.env.ANCHOR_WALLET;
    }
    if (origBakeRpcOverride !== undefined) {
      process.env.BAKE_RPC_URL = origBakeRpcOverride;
    } else {
      delete process.env.BAKE_RPC_URL;
    }
  };

  return { env, restore };
}
