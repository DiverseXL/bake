import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fail } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { getActiveCluster, getConnection } from "../lib/connection.js";
import { getWalletPath, loadLocalWallet } from "../lib/wallet.js";
import {
  getRecipeBookClient,
  isMockRecipeBookClient,
} from "../lib/recipeBook.js";
import {
  resolveProgramIdFromAnchorProject,
  resolveProgramName,
} from "../lib/anchorProject.js";

const MAX_REPO_LEN = 200;
const MAX_COMMIT_LEN = 44;

interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

class ToolError extends Error {
  constructor(
    readonly command: string,
    readonly result: ToolResult,
    readonly cause?: Error,
  ) {
    const codePart =
      result.code !== 0 ? `failed with exit code ${result.code}` : "failed";
    super(`\`${command}\` ${codePart}`);
    this.name = "ToolError";
  }
}

function isJsonMode(): boolean {
  return process.env.BAKE_JSON === "true";
}

function isCiMode(): boolean {
  return process.env.BAKE_CI === "true";
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function printToolOutput(result: ToolResult): void {
  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();
  if (stdout) {
    console.error(chalk.dim("----- stdout -----"));
    console.error(stdout);
  }
  if (stderr) {
    console.error(chalk.dim("----- stderr -----"));
    console.error(stderr);
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: process.platform === "win32",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (err: Error) => {
      reject(
        new ToolError(displayCommand(command, args), { code: 1, stdout, stderr }, err),
      );
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function displayCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

async function runRequired(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ToolResult> {
  const label = displayCommand(command, args);
  let result: ToolResult;
  try {
    result = await runCommand(command, args, options);
  } catch (err) {
    if (err instanceof ToolError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ToolError(label, { code: 1, stdout: "", stderr: msg }, err instanceof Error ? err : undefined);
  }
  if (result.code !== 0) {
    throw new ToolError(label, result);
  }
  return result;
}

type StepHandle = {
  succeed: (text?: string) => void;
  fail: (text?: string) => void;
};

function startStep(text: string): StepHandle {
  if (isJsonMode()) {
    return { succeed() {}, fail() {} };
  }
  if (isCiMode()) {
    logger.info(text);
    return {
      succeed: (msg) => logger.success(msg ?? `✓ ${text}`),
      fail: (msg) => logger.error(msg ?? `✗ ${text}`),
    };
  }
  const spinner = ora(text).start();
  return {
    succeed: (msg) => spinner.succeed(msg ?? text),
    fail: (msg) => spinner.fail(msg ?? text),
  };
}

function parseDeploySignature(output: string): string | null {
  const match =
    output.match(/^\s*Signature:\s+(\S+)/m) ??
    output.match(/Program Id:\s+\S+[\s\S]*?Signature:\s+(\S+)/);
  return match?.[1] ?? null;
}

async function gitCommit(): Promise<string> {
  try {
    const result = await runCommand("git", ["rev-parse", "HEAD"]);
    if (result.code === 0) {
      const commit = result.stdout.trim();
      if (commit) return commit.slice(0, MAX_COMMIT_LEN);
    }
  } catch {
    // fall through
  }
  if (!isJsonMode()) {
    logger.warn('Could not determine git commit — using "unknown"');
  }
  return "unknown";
}

async function gitRepo(): Promise<string> {
  try {
    const result = await runCommand("git", ["remote", "get-url", "origin"]);
    if (result.code === 0) {
      const url = result.stdout.trim();
      if (url) return url.slice(0, MAX_REPO_LEN);
    }
  } catch {
    // fall through
  }
  if (!isJsonMode()) {
    logger.warn('Could not determine git remote — using "local"');
  }
  return "local";
}

function handleToolFailure(err: unknown): never {
  if (err instanceof ToolError) {
    const enoent =
      err.cause && "code" in err.cause && (err.cause as NodeJS.ErrnoException).code === "ENOENT";
    printToolOutput(err.result);
    if (enoent || /not recognized|ENOENT|command not found/i.test(err.result.stderr + err.message)) {
      fail(
        `${err.message}. Is the Anchor CLI installed and on your PATH?`,
      );
    }
    fail(err.message);
  }
  throw err;
}

interface DeployJson {
  programId: string;
  deploySignature: string;
  entryIndex: number;
  cluster: string;
  elapsedMs: number;
  mock: boolean;
}

async function runDeploy(): Promise<void> {
  const cwd = process.cwd();
  const tomlPath = join(cwd, "Anchor.toml");
  if (!existsSync(tomlPath)) {
    fail("No Anchor.toml found — run this from your program's root directory.");
  }

  const started = performance.now();
  const toml = readFileSync(tomlPath, "utf-8");
  const programName = resolveProgramName(cwd, toml);

  // a. anchor build
  const buildStep = startStep(`Building ${programName} (anchor build)`);
  try {
    await runRequired("anchor", ["build"], { cwd });
    buildStep.succeed(`Built ${programName}`);
  } catch (err) {
    buildStep.fail(`Build failed for ${programName}`);
    handleToolFailure(err);
  }

  // b. program keypair / ID from target/deploy/<name>-keypair.json
  const keypairPath = join(cwd, "target", "deploy", `${programName}-keypair.json`);
  const soPath = join(cwd, "target", "deploy", `${programName}.so`);
  if (!existsSync(keypairPath)) {
    fail(
      `Program keypair not found at ${keypairPath} after a successful build.`,
    );
  }
  const programId = resolveProgramIdFromAnchorProject(cwd);
  if (!programId) {
    fail("No Anchor.toml found — run this from your program's root directory.");
  }

  if (!existsSync(soPath)) {
    fail(`Compiled program not found at ${soPath} after a successful build.`);
  }

  // c. connection + local wallet
  const cluster = getActiveCluster();
  getConnection(); // RPC handle reserved for the real Recipe Book client
  const wallet = loadLocalWallet();
  const walletPath = getWalletPath();

  // d. anchor deploy against the active cluster
  const deployStep = startStep(`Deploying ${programName} to ${cluster.name}`);
  let chainSignature: string | null = null;
  try {
    const result = await runRequired("anchor", ["deploy"], {
      cwd,
      env: {
        ANCHOR_PROVIDER_URL: cluster.rpcUrl,
        ANCHOR_WALLET: walletPath,
      },
    });
    chainSignature = parseDeploySignature(`${result.stdout}\n${result.stderr}`);
    deployStep.succeed(`Deployed ${programName} to ${cluster.name}`);
  } catch (err) {
    deployStep.fail(`Deploy failed for ${programName}`);
    handleToolFailure(err);
  }

  // e. sha256 of the compiled .so
  const hashStep = startStep("Computing build hash");
  let buildHash: Uint8Array;
  try {
    const soBytes = readFileSync(soPath);
    buildHash = new Uint8Array(createHash("sha256").update(soBytes).digest());
    hashStep.succeed("Computed build hash");
  } catch (err) {
    hashStep.fail("Failed to hash compiled program");
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Failed to read compiled program at ${soPath}: ${msg}`);
  }

  // f. git commit + repo identifier
  const metaStep = startStep("Collecting git metadata");
  const commit = await gitCommit();
  const repo = await gitRepo();
  metaStep.succeed("Collected git metadata");

  // g. Recipe Book: initialize if needed, then register this deploy
  const recipeStep = startStep("Registering deploy in Recipe Book");
  const client = getRecipeBookClient();
  const mock = isMockRecipeBookClient(client);
  let entryIndex: number;
  let recipeSignature: string;
  try {
    const exists = await client.recipeBookExists(programId);
    if (!exists) {
      await client.initializeRecipeBook(programId, wallet);
    }
    // buffer is a placeholder until the real upgrade-buffer flow is wired;
    // reuse the program ID so the mock (and later the real client) still
    // receive a PublicKey in the field the on-chain instruction expects.
    const registered = await client.registerDeploy(
      programId,
      { repo, commit, buildHash, buffer: programId },
      wallet,
    );
    entryIndex = registered.entryIndex;
    recipeSignature = registered.signature;
    recipeStep.succeed(
      mock
        ? `Registered deploy in Recipe Book (mock, entry #${entryIndex})`
        : `Registered deploy in Recipe Book (entry #${entryIndex})`,
    );
  } catch (err) {
    recipeStep.fail("Recipe Book registration failed");
    const msg = err instanceof Error ? err.message : String(err);
    fail(
      `Program deployed${chainSignature ? ` (signature ${chainSignature})` : ""} but Recipe Book registration failed: ${msg}`,
    );
  }

  const elapsedMs = Math.round(performance.now() - started);
  const deploySignature = mock ? "mock" : (recipeSignature || chainSignature || "unknown");

  const json: DeployJson = {
    programId: programId.toBase58(),
    deploySignature,
    entryIndex,
    cluster: cluster.name,
    elapsedMs,
    mock,
  };

  if (isJsonMode()) {
    console.log(JSON.stringify(json));
    return;
  }

  logger.success("\nDeploy complete\n");
  console.log(`  Program ID:        ${chalk.bold(programId.toBase58())}`);
  console.log(`  Deploy signature:  ${chalk.bold(deploySignature)}`);
  if (chainSignature && mock) {
    console.log(`  Chain signature:   ${chalk.dim(chainSignature)}`);
  }
  console.log(`  Entry index:       ${entryIndex}`);
  console.log(`  Cluster:           ${cluster.name} (${chalk.dim(cluster.rpcUrl)})`);
  console.log(`  Elapsed:           ${chalk.bold(formatElapsed(elapsedMs))}`);
  console.log();
}

export const deployCommand = new Command("deploy")
  .description("Deploy an Anchor program to the active cluster")
  // Also accepted on the subcommand so `bake deploy --json` works (global
  // flags are set in the root preAction when passed before the subcommand).
  .option("--json", "output results as JSON")
  .option("--ci", "disable spinners/colors, force JSON-safe output")
  .action(async (opts: { json?: boolean; ci?: boolean }) => {
    if (opts.json) process.env.BAKE_JSON = "true";
    if (opts.ci) process.env.BAKE_CI = "true";
    await runDeploy();
  });
