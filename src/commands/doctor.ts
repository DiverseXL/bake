import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { checkWslToolchain } from "../lib/toolchain.js";
import { resolveWalletPath } from "../lib/wallet.js";
import { getActiveCluster, getConnection } from "../lib/connection.js";
import { resolveProgramIdFromAnchorProject } from "../lib/anchorProject.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DoctorCheck {
  name: string;
  category: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

type CheckFn = () => Promise<DoctorCheck>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RPC_TIMEOUT_MS = 5_000;
const NODE_MIN_MAJOR = 22;

function getNodeMajorVersion(): number {
  const match = process.version.match(/^v(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function isJsonMode(): boolean {
  return process.env.BAKE_JSON === "true";
}

function isCiMode(): boolean {
  return process.env.BAKE_CI === "true";
}

// ---------------------------------------------------------------------------
// Individual checks — each composes existing logic, never reimplements
// ---------------------------------------------------------------------------

/** Node.js version >= 22 (same gate as cookieMcpClient.ts). */
async function checkNode(): Promise<DoctorCheck> {
  const major = getNodeMajorVersion();
  const detail = `Node.js ${process.version} (>= ${NODE_MIN_MAJOR} required)`;
  if (major >= NODE_MIN_MAJOR) {
    return { name: "Node.js", category: "Environment", status: "pass", detail };
  }
  return { name: "Node.js", category: "Environment", status: "fail", detail };
}

/** Git on PATH + inside a git repo. */
async function checkGit(): Promise<DoctorCheck> {
  const { spawn } = await import("node:child_process");
  const run = (args: string[]): Promise<{ exitCode: number; stdout: string }> =>
    new Promise((resolve) => {
      const child = spawn("git", args, { windowsHide: true, shell: false });
      let stdout = "";
      child.stdout.on("data", (c: Buffer | string) => { stdout += c.toString(); });
      child.on("error", () => resolve({ exitCode: 1, stdout: "" }));
      child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
    });

  const versionResult = await run(["--version"]);
  if (versionResult.exitCode !== 0) {
    return { name: "git", category: "Environment", status: "fail", detail: "git not found on PATH" };
  }
  const repoResult = await run(["rev-parse", "--is-inside-work-tree"]);
  if (repoResult.exitCode !== 0) {
    return { name: "git", category: "Environment", status: "warn", detail: "git available but not inside a git repository" };
  }
  return { name: "git", category: "Environment", status: "pass", detail: "git available, inside a git repository" };
}

/** WSL + Ubuntu toolchain on Windows; skipped on macOS/Linux. */
async function checkWsl(): Promise<DoctorCheck> {
  if (process.platform !== "win32") {
    return { name: "WSL toolchain", category: "Environment", status: "pass", detail: "Not Windows — native toolchain execution is available" };
  }
  const result = await checkWslToolchain();
  if (result.ok) {
    return { name: "WSL toolchain", category: "Environment", status: "pass", detail: "WSL + Ubuntu toolchain ready (Windows only)" };
  }
  return { name: "WSL toolchain", category: "Environment", status: "fail", detail: result.message };
}

/** Local wallet existence + truncated public key. */
async function checkWallet(): Promise<DoctorCheck> {
  const walletPath = resolveWalletPath();
  if (!walletPath) {
    return { name: "Local wallet", category: "Wallet & Cluster", status: "fail", detail: "No local wallet found — run `bake login` to set one up" };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(walletPath, "utf-8"));
    if (!Array.isArray(raw) || !raw.every((n) => typeof n === "number")) {
      return { name: "Local wallet", category: "Wallet & Cluster", status: "fail", detail: `Keypair file at ${walletPath} is malformed` };
    }
    const bytes = Uint8Array.from(raw as number[]);
    if (bytes.length !== 64) {
      return { name: "Local wallet", category: "Wallet & Cluster", status: "fail", detail: `Keypair file at ${walletPath} is ${bytes.length} bytes (expected 64)` };
    }
    const pubKey = Keypair.fromSecretKey(bytes).publicKey.toBase58();
    const truncated = `${pubKey.slice(0, 6)}…${pubKey.slice(-4)}`;
    return { name: "Local wallet", category: "Wallet & Cluster", status: "pass", detail: `Local wallet configured: ${truncated}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: "Local wallet", category: "Wallet & Cluster", status: "fail", detail: `Failed to load wallet at ${walletPath}: ${msg}` };
  }
}

/** Active cluster reachability (getSlot with timeout — same pattern as bake use). */
async function checkCluster(): Promise<DoctorCheck> {
  const cluster = getActiveCluster();
  try {
    const connection = getConnection(cluster.rpcUrl);
    const slot = await Promise.race([
      connection.getSlot("confirmed"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("RPC probe timed out")), RPC_TIMEOUT_MS),
      ),
    ]);
    return {
      name: "Cluster reachability",
      category: "Wallet & Cluster",
      status: "pass",
      detail: `Active cluster: ${cluster.name} (${cluster.rpcUrl}) — reachable, slot ${slot}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "Cluster reachability",
      category: "Wallet & Cluster",
      status: "fail",
      detail: `Active cluster: ${cluster.name} (${cluster.rpcUrl}) — unreachable: ${msg}`,
    };
  }
}

/** Wallet SOL balance — warns if zero, fails only if negative (shouldn't happen). */
async function checkBalance(): Promise<DoctorCheck> {
  const walletPath = resolveWalletPath();
  if (!walletPath) {
    // Wallet check already reports this failure — skip to avoid double-reporting.
    return { name: "Wallet balance", category: "Wallet & Cluster", status: "warn", detail: "Skipped — no wallet configured" };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(walletPath, "utf-8"));
    const bytes = Uint8Array.from(raw as number[]);
    const pubKey = Keypair.fromSecretKey(bytes).publicKey;
    const cluster = getActiveCluster();
    const connection = getConnection(cluster.rpcUrl);
    const lamports = await Promise.race([
      connection.getBalance(pubKey),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Balance probe timed out")), RPC_TIMEOUT_MS),
      ),
    ]);
    const sol = lamports / 1_000_000_000;
    if (sol === 0) {
      return { name: "Wallet balance", category: "Wallet & Cluster", status: "warn", detail: `Wallet balance: 0 COOK — may not be enough for deploys` };
    }
    return { name: "Wallet balance", category: "Wallet & Cluster", status: "pass", detail: `Wallet balance: ${sol.toLocaleString("en-US", { maximumFractionDigits: 4 })} COOK` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: "Wallet balance", category: "Wallet & Cluster", status: "warn", detail: `Could not fetch balance: ${msg}` };
  }
}

/** Anchor project detection — Anchor.toml + program ID resolution. */
async function checkAnchorProject(): Promise<DoctorCheck> {
  const cwd = process.cwd();
  const tomlPath = join(cwd, "Anchor.toml");
  if (!existsSync(tomlPath)) {
    return { name: "Anchor project", category: "Project", status: "warn", detail: "No Anchor.toml found in current directory" };
  }
  try {
    const programId = resolveProgramIdFromAnchorProject(cwd);
    if (programId) {
      return { name: "Anchor project", category: "Project", status: "pass", detail: `Anchor.toml found, program: ${programId.toBase58().slice(0, 8)}…` };
    }
    return { name: "Anchor project", category: "Project", status: "warn", detail: "Anchor.toml found but could not resolve program ID" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: "Anchor project", category: "Project", status: "warn", detail: `Anchor.toml found but program ID resolution failed: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// All checks in execution order
// ---------------------------------------------------------------------------

const ALL_CHECKS: CheckFn[] = [
  checkNode,
  checkGit,
  checkWsl,
  checkWallet,
  checkCluster,
  checkBalance,
  checkAnchorProject,
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runDoctor(): Promise<void> {
  const checks: DoctorCheck[] = [];

  for (const fn of ALL_CHECKS) {
    try {
      checks.push(await fn());
    } catch (err) {
      // A check itself threw unexpectedly — treat as a failure, not a crash.
      checks.push({
        name: fn.name,
        category: "Unknown",
        status: "fail",
        detail: `Check crashed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Determine overall status.
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  const overallStatus = hasFail ? "fail" : hasWarn ? "warn" : "pass";

  // --- JSON output ---
  if (isJsonMode()) {
    console.log(JSON.stringify({ checks, overallStatus }, null, 2));
    process.exitCode = hasFail ? 1 : 0;
    return;
  }

  // --- Human-readable output ---
  const ci = isCiMode();

  // Group checks by category.
  const categories = new Map<string, DoctorCheck[]>();
  for (const check of checks) {
    const cat = check.category;
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push(check);
  }

  const statusIcon = (s: "pass" | "warn" | "fail"): string => {
    if (s === "pass") return ci ? "[OK]" : chalk.green("✔");
    if (s === "warn") return ci ? "[WARN]" : chalk.yellow("⚠");
    return ci ? "[FAIL]" : chalk.red("✘");
  };

  console.log();
  for (const [category, catChecks] of categories) {
    console.log(`  ${chalk.bold(category)}`);
    for (const check of catChecks) {
      const icon = statusIcon(check.status);
      const name = check.name;
      const detail = check.detail;
      console.log(`    ${icon} ${chalk.dim(name + ":")} ${detail}`);
    }
    console.log();
  }

  // Summary line
  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const passCount = checks.filter((c) => c.status === "pass").length;

  if (ci) {
    console.log(`Result: ${overallStatus.toUpperCase()} (${passCount} passed, ${warnCount} warnings, ${failCount} failures)`);
  } else {
    if (overallStatus === "pass") {
      console.log(chalk.green(`  All checks passed (${passCount})`));
    } else if (overallStatus === "warn") {
      console.log(chalk.yellow(`  ${passCount} passed, ${warnCount} warning(s), ${failCount} failure(s)`));
    } else {
      console.log(chalk.red(`  ${failCount} failure(s), ${warnCount} warning(s), ${passCount} passed`));
    }
  }
  console.log();

  process.exitCode = hasFail ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Export the commander command
// ---------------------------------------------------------------------------

export const doctorCommand = new Command("doctor")
  .description("Check your local environment and report what's ready vs what needs attention")
  .action(async () => {
    await runDoctor();
  });
