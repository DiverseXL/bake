import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { z } from "zod";
import {
  globalConfigSchema,
  projectConfigSchema,
  mergedConfigSchema,
  type MergedConfig,
} from "./types.js";
import chalk from "chalk";

const GLOBAL_CONFIG_DIR = join(homedir(), ".bake");
const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "config.json");
const GLOBAL_CONFIG_LOCK_PATH = join(GLOBAL_CONFIG_DIR, "config.lock");
const PROJECT_CONFIG_NAME = "bake.config.json";

// ---------------------------------------------------------------------------
// File-lock helpers
//
// Pattern: atomic 'wx' open creates the lock file only if it doesn't exist
// (this is an OS-level atomic check — no TOCTOU race between test and create).
// Staleness detection removes locks left behind by crashed processes.
// ---------------------------------------------------------------------------

/** How long (ms) before a lock file is considered stale from a crashed process. */
const LOCK_STALE_AGE_MS = 5_000;
/** Interval (ms) between lock-acquisition retries. */
const LOCK_RETRY_INTERVAL_MS = 50;
/** Maximum number of acquisition attempts before giving up with a warning. */
const LOCK_MAX_RETRIES = 10;

/**
 * Try to acquire a file lock at the given path.
 * Returns true if acquired, false if already held by another process.
 * Clears stale locks (older than LOCK_STALE_AGE_MS) automatically.
 */
function tryAcquireLock(lockPath: string): boolean {
  // Staleness check — remove if abandoned by a crashed process.
  if (existsSync(lockPath)) {
    try {
      const st = statSync(lockPath);
      const ageMs = Date.now() - st.mtimeMs;
      if (ageMs > LOCK_STALE_AGE_MS) {
        unlinkSync(lockPath);
      } else {
        return false; // Legitimately held by another live process.
      }
    } catch {
      // stat/unlink race — another process beat us; treat as held.
      return false;
    }
  }

  try {
    // 'wx' = O_CREAT | O_EXCL — fails atomically if the file exists.
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sleep synchronously without burning CPU.
 * `Atomics.wait` on a throwaway SharedArrayBuffer is the only
 * dependency-free synchronous sleep in Node; fall back to a busy spin if the
 * runtime ever refuses it.
 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* fallback spin */ }
  }
}

/**
 * How many nested lock scopes this process currently holds. The lock is
 * reentrant within a process: an `updateGlobalConfig()` callback that calls
 * `writeGlobalConfig()` must not mistake its own lock for contention, nor
 * release it before the outer scope is done.
 */
let globalLockDepth = 0;

/**
 * Acquire the global config file lock, retrying with backoff.
 *
 * Returns true when this call owns the lock. Returns false if the lock could
 * not be acquired after all retries — in that case a warning is logged and
 * the caller proceeds anyway, because a stale lock from a crashed process
 * must never permanently block the user.
 */
function acquireGlobalConfigLock(): boolean {
  // Reentrant: already held by this process.
  if (globalLockDepth > 0) {
    globalLockDepth++;
    return true;
  }

  ensureGlobalConfigDir();
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    if (tryAcquireLock(GLOBAL_CONFIG_LOCK_PATH)) {
      globalLockDepth = 1;
      return true;
    }
    sleepSync(LOCK_RETRY_INTERVAL_MS);
  }
  // Warn but do not throw — a concurrent bake process might have crashed
  // while holding the lock, and we don't want to permanently block the user.
  console.error(
    "Warning: could not acquire ~/.bake/config.lock after retries — " +
    "another bake process may be running. Proceeding anyway; config write " +
    "may be overwritten if two processes complete at the same time.",
  );
  return false;
}

/**
 * Release the global config file lock.
 *
 * Only unlinks the lock file when this process actually acquired it
 * (`acquired === true`). Without that guard, a process that merely gave up
 * and proceeded optimistically would delete a *live* lock belonging to
 * another process, defeating the mutual exclusion entirely.
 *
 * Called from `finally` blocks so a crash during the write still releases
 * the lock instead of leaving a permanent stale lock behind.
 */
function releaseGlobalConfigLock(acquired: boolean): void {
  if (!acquired) return;
  globalLockDepth--;
  if (globalLockDepth > 0) return; // Still inside an outer lock scope.
  globalLockDepth = 0;
  try {
    unlinkSync(GLOBAL_CONFIG_LOCK_PATH);
  } catch {
    // Best-effort release; the staleness check clears it if it lingers.
  }
}

// ---------------------------------------------------------------------------
// Config read helpers
// ---------------------------------------------------------------------------

function safeReadJson(path: string, label: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : `Unable to read ${label}`;
    throw new Error(`Malformed ${label} at ${path}: ${message}`);
  }
}

export async function loadConfigs(): Promise<MergedConfig> {
  // In this skeleton, loading is synchronous; kept async for future expansion.
  const cwd = process.cwd();

  const globalRaw = safeReadJson(GLOBAL_CONFIG_PATH, "global config");
  const projectRaw = safeReadJson(join(cwd, PROJECT_CONFIG_NAME), "project config");

  // Validate each file independently so errors are clear.
  const globalConfig = globalRaw ? globalConfigSchema.parse(globalRaw) : globalConfigSchema.parse({});
  const projectConfig = projectRaw ? projectConfigSchema.parse(projectRaw) : projectConfigSchema.parse({});

  // Merge: project overrides global where provided.
  const merged = mergedConfigSchema.parse({ ...globalConfig, ...projectConfig });

  return merged;
}

export function getGlobalConfigPath(): string {
  return GLOBAL_CONFIG_PATH;
}

export function getGlobalConfigDir(): string {
  return GLOBAL_CONFIG_DIR;
}

export function ensureGlobalConfigDir(): void {
  if (!existsSync(GLOBAL_CONFIG_DIR)) {
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  }
}

export function readGlobalConfig(): MergedConfig | null {
  if (!existsSync(GLOBAL_CONFIG_PATH)) return null;
  try {
    const raw = readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return globalConfigSchema.parse(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: ignoring corrupted global config (${GLOBAL_CONFIG_PATH}): ${msg}`);
    return null;
  }
}

/**
 * Write the global config atomically under a file lock.
 *
 * The lock prevents two concurrent `bake` processes (e.g. `bake fork`
 * running a validator in one terminal while `bake use` runs in another)
 * from performing a read-modify-write that silently overwrites each other.
 *
 * Mechanism:
 * 1. Acquire ~/.bake/config.lock via O_CREAT|O_EXCL (atomic OS call).
 * 2. Retry up to 10×50ms if held; if still blocked, warn and proceed
 *    (a stale lock from a crashed process must not permanently block users).
 * 3. Stale locks (> 5s old) are removed automatically before retrying.
 * 4. The lock is released in a `finally` block — but only if this process
 *    actually acquired it, so a process that gave up never deletes a live
 *    lock owned by another process.
 */
export function writeGlobalConfig(data: Record<string, unknown>): void {
  const acquired = acquireGlobalConfigLock();
  try {
    writeGlobalConfigFile(data);
  } finally {
    releaseGlobalConfigLock(acquired);
  }
}

/** Validate and write the config file. Callers must already hold the lock. */
function writeGlobalConfigFile(data: Record<string, unknown>): void {
  ensureGlobalConfigDir();
  const validated = globalConfigSchema.parse(data);
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(validated, null, 2), "utf-8");
}

/**
 * Atomically read-modify-write the global config while holding the lock.
 *
 * This is the entry point commands should use when updating a single field
 * (`bake use` setting activeCluster, `bake login` setting walletPath, ...).
 * Locking only the final write is not enough: two processes can both read the
 * same base config, then write in turn, and the second write silently drops
 * the first process's field. Holding the lock across the whole read →
 * modify → write sequence is what actually prevents that clobbering.
 *
 * The mutator receives a mutable copy of the current config and may either
 * mutate it in place (returning nothing) or return a replacement object.
 * If acquisition failed (stale/live lock after retries) we still write, per
 * the best-effort policy above — just with a warning already logged.
 */
export function updateGlobalConfig(
  mutate: (current: Record<string, unknown>) => Record<string, unknown> | void,
): void {
  const acquired = acquireGlobalConfigLock();
  try {
    const current =
      (readGlobalConfig() as unknown as Record<string, unknown> | null) ?? {};
    const draft = { ...current };
    // Mutators may either mutate `draft` in place (returning nothing) or
    // return a replacement object — keep the draft in the former case.
    const next = mutate(draft) ?? draft;
    writeGlobalConfigFile(next);
  } finally {
    releaseGlobalConfigLock(acquired);
  }
}

export function readProjectConfig(): MergedConfig | null {
  const cwd = process.cwd();
  const path = join(cwd, PROJECT_CONFIG_NAME);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return projectConfigSchema.parse(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: ignoring corrupted project config (${path}): ${msg}`);
    return null;
  }
}

/**
 * Write the project config (bake.config.json in cwd).
 * Project configs are not shared across concurrent processes in any realistic
 * scenario, so no lock is applied here — project config writes happen only
 * during `bake init` which is not run concurrently.
 */
export function writeProjectConfig(data: Record<string, unknown>): void {
  const cwd = process.cwd();
  const path = join(cwd, PROJECT_CONFIG_NAME);
  const validated = projectConfigSchema.parse(data);
  writeFileSync(path, JSON.stringify(validated, null, 2), "utf-8");
}

// Friendly validation helper for reuse in commands that want to show config errors.
export function validateConfigFile(path: string, label: string): MergedConfig {
  const raw = safeReadJson(path, label);
  if (!raw) {
    throw new Error(`${label} not found at ${path}`);
  }
  try {
    return mergedConfigSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.errors
        .map((issue) => {
          const pathStr = issue.path.join(".");
          return `  - ${pathStr || "root"}: ${issue.message}`;
        })
        .join("\n");
      throw new Error(
        chalk.red(`\n${label} is invalid:\n${issues}\n`)
      );
    }
    throw err as Error;
  }
}
