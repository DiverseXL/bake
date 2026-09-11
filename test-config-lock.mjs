/**
 * test-config-lock.mjs
 *
 * Exercises the config file-lock mechanism in src/config/index.ts.
 *
 *   1. Concurrency: fire two `bake use <cluster>` processes at the same instant
 *      and confirm ~/.bake/config.json is valid, non-torn JSON ending on one
 *      of the two intended values, with unrelated fields preserved.
 *   2. Stale lock: plant a 10-second-old lock and confirm `updateGlobalConfig`
 *      clears it and proceeds immediately (no hang).
 *   3. Live lock guard: hold a *fresh* lock manually and confirm the process
 *      retries, warns, proceeds anyway, and — critically — does NOT delete the
 *      lock it never acquired.
 *   4. Normal single-process usage (`bake whoami` / `bake use`) is unaffected:
 *      no spurious warnings, no lock-induced delay.
 *
 * Timing assertions for lock behaviour call the config module directly so the
 * measurements are not polluted by the RPC reachability probe that `bake use`
 * performs (which can take seconds on an offline cluster).
 *
 * Run from the bake workspace root (after `npm run build`):
 *   node test-config-lock.mjs
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync, readFileSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  updateGlobalConfig,
  getGlobalConfigDir,
} from "./dist/config/index.js";

const execP = promisify(exec);

const BAKE_CONFIG = join(homedir(), ".bake", "config.json");
const BAKE_LOCK = join(getGlobalConfigDir(), "config.lock");

function readConfigJSON() {
  try {
    return JSON.parse(readFileSync(BAKE_CONFIG, "utf-8"));
  } catch {
    return null;
  }
}

function writeConfigJSON(obj) {
  writeFileSync(BAKE_CONFIG, JSON.stringify(obj, null, 2), "utf-8");
}

function plantLock(ageMs) {
  writeFileSync(BAKE_LOCK, "test-lock", "utf-8");
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(BAKE_LOCK, t, t);
  }
}

function clearLock() {
  try {
    if (existsSync(BAKE_LOCK)) unlinkSync(BAKE_LOCK);
  } catch {
    /* ignore */
  }
}

let failures = 0;
function pass(label) {
  console.log(`  \u2714 ${label}`);
}
function fail(label, reason) {
  console.error(`  \u2717 ${label}: ${reason}`);
  failures++;
}

const SENTINEL = "__lock_test_sentinel__";
// Snapshot the real config so the test can restore it (including the active
// cluster) instead of leaving the developer's environment mutated.
const ORIGINAL_CONFIG = readConfigJSON();

// ---------------------------------------------------------------------------
// Test 1 — Concurrency: two `bake use` at the same instant
// ---------------------------------------------------------------------------
console.log("\n\u2500\u2500 Test 1: Concurrent bake use (two clusters at once) \u2500\u2500");

// Seed the config with a sentinel field alongside the real contents so we can
// detect a lost-update (clobbered) write, not just a torn write.
const seed = readConfigJSON() ?? {};
seed.preferences = { ...(seed.preferences ?? {}), [SENTINEL]: true };
writeConfigJSON(seed);

const [a, b] = await Promise.allSettled([
  execP("node dist/index.js use devnet", { cwd: process.cwd() }),
  execP("node dist/index.js use cookie", { cwd: process.cwd() }),
]);

const cfg1 = readConfigJSON();
if (!cfg1) {
  fail("Config readable after concurrent writes", "file is not valid JSON or missing");
} else {
  const name = cfg1?.activeCluster?.name;
  if (name === "devnet" || name === "cookie") {
    pass(`Valid JSON with a coherent activeCluster.name = "${name}"`);
  } else {
    fail("Active cluster is one of the two intended values", `got: ${JSON.stringify(name)}`);
  }
  if (cfg1?.preferences?.[SENTINEL] === true) {
    pass("Unrelated config field survived both concurrent read-modify-writes (no clobber)");
  } else {
    fail("Unrelated field preserved", "sentinel was lost by a concurrent write");
  }
}

if (a.status === "rejected") console.log("  (bake use devnet stderr):", a.reason?.stderr?.trim());
if (b.status === "rejected") console.log("  (bake use cookie stderr):", b.reason?.stderr?.trim());

// ---------------------------------------------------------------------------
// Test 2 — Stale lock detection (direct, no RPC noise)
// ---------------------------------------------------------------------------
console.log("\n\u2500\u2500 Test 2: Stale lock file (10 seconds old) \u2500\u2500");
plantLock(10_000);
console.log(`  Planted stale lock (mtime = ${new Date(Date.now() - 10_000).toISOString()})`);

const t2 = Date.now();
updateGlobalConfig((data) => {
  data.preferences = { ...(data.preferences ?? {}), staleRecovered: true };
});
const staleElapsed = Date.now() - t2;

if (!existsSync(BAKE_LOCK)) {
  pass("Stale lock was removed during the write");
} else {
  fail("Stale lock removed", "lock file still exists");
}
if (staleElapsed < 200) {
  pass(`Stale lock did not cause a hang (${staleElapsed}ms)`);
} else {
  fail("No hang", `took ${staleElapsed}ms`);
}
if (readConfigJSON()?.preferences?.staleRecovered === true) {
  pass("Config correctly written after stale-lock recovery");
} else {
  fail("Write after stale lock", "field not present");
}

// ---------------------------------------------------------------------------
// Test 3 — Live lock: retry + warn + proceed, and don't delete someone else's lock
// ---------------------------------------------------------------------------
console.log("\n\u2500\u2500 Test 3: Live lock held by another process \u2500\u2500");
clearLock();
plantLock(0); // fresh mtime => treated as a live lock

const t3 = Date.now();
updateGlobalConfig((data) => {
  data.preferences = { ...(data.preferences ?? {}), liveFallback: true };
});
const liveElapsed = Date.now() - t3;

if (liveElapsed >= 400 && liveElapsed < 3_000) {
  pass(`Retried with backoff before giving up (${liveElapsed}ms, ~10 \u00d7 50ms)`);
} else {
  fail("Retry/backoff timing", `${liveElapsed}ms (expected ~500ms)`);
}
if (existsSync(BAKE_LOCK)) {
  pass("Lock it never acquired was NOT deleted (release-guard works)");
} else {
  fail("Release guard", "process deleted a lock it did not own");
}
clearLock();

// ---------------------------------------------------------------------------
// Test 4 — Normal single-process usage
// ---------------------------------------------------------------------------
console.log("\n\u2500\u2500 Test 4: Normal single-process usage (whoami) \u2500\u2500");
const t4 = Date.now();
try {
  const { stdout: whoami } = await execP("node dist/index.js whoami", { cwd: process.cwd() });
  const elapsed = Date.now() - t4;
  if (whoami.includes("Cluster:") && whoami.includes("Local key:")) {
    pass(`bake whoami OK in ${elapsed}ms`);
  } else {
    fail("bake whoami output", whoami.trim());
  }
  if (elapsed < 3_000) {
    pass(`No lock-induced delay (${elapsed}ms)`);
  } else {
    fail("Timing", `bake whoami took ${elapsed}ms`);
  }
  if (!whoami.includes("config.lock")) {
    pass("No spurious lock warnings in normal output");
  } else {
    fail("Spurious warning", "lock warning appeared in whoami output");
  }
} catch (err) {
  fail("bake whoami", err?.stderr ?? err?.message ?? String(err));
}

// Restore the developer's original config (or just strip test fields) and
// clear any leftover lock.
try {
  if (ORIGINAL_CONFIG) {
    writeConfigJSON(ORIGINAL_CONFIG);
  } else {
    const finalCfg = readConfigJSON();
    if (finalCfg?.preferences) {
      delete finalCfg.preferences[SENTINEL];
      delete finalCfg.preferences.staleRecovered;
      delete finalCfg.preferences.liveFallback;
      writeConfigJSON(finalCfg);
    }
  }
} catch {
  /* ignore */
}
clearLock();

console.log("\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
console.log(failures === 0 ? "RESULT: ALL TESTS PASSED" : `RESULT: ${failures} TEST(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
