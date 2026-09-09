import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { fail } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { getActiveCluster } from "../lib/connection.js";
import { runDeployPipeline } from "../lib/deployPipeline.js";

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function isJsonMode(): boolean {
  return process.env.BAKE_JSON === "true";
}

function isCiMode(): boolean {
  return process.env.BAKE_CI === "true";
}

function isYesMode(): boolean {
  return process.env.BAKE_YES === "true";
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(chalk.bold(question) + " (y/N) ", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
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

// ---------------------------------------------------------------------------
// Deploy command
// ---------------------------------------------------------------------------

interface DeployJson {
  programId: string;
  deploySignature: string;
  entryIndex: number;
  cluster: string;
  elapsedMs: number;
  mock: boolean;
}

async function runDeploy(): Promise<void> {
  const cwd = existsSync(join(process.cwd(), "Anchor.toml"))
    ? process.cwd()
    : join(process.cwd(), "anchor");
  const tomlPath = join(cwd, "Anchor.toml");
  if (!existsSync(tomlPath)) {
    fail("No Anchor.toml found — run this from your program's root directory.");
  }

  const started = performance.now();
  const cluster = getActiveCluster();

  if (!isCiMode() && !isJsonMode() && !isYesMode()) {
    logger.info(`\n  Cluster:  ${cluster.name} (${chalk.dim(cluster.rpcUrl)})`);
    const ok = await promptYesNo("\nDeploy to this cluster?");
    if (!ok) {
      logger.warn("Deploy cancelled.");
      process.exit(0);
    }
  }

  // Delegate the full build→deploy→hash→register pipeline to the shared
  // function. This is the same function bake rollback calls — both commands
  // share exactly one implementation of the deploy sequence.
  const pipelineStep = startStep("Building and deploying");
  let result;
  try {
    result = await runDeployPipeline(cwd);
    pipelineStep.succeed(
      result.mock
        ? `Deployed (mock, entry #${result.entryIndex})`
        : `Deployed to ${cluster.name} (entry #${result.entryIndex})`,
    );
  } catch (err) {
    pipelineStep.fail("Deploy failed");
    const msg = err instanceof Error ? err.message : String(err);
    // Best-effort ENOENT detection for Anchor CLI
    if (/ENOENT|not found|command not found/i.test(msg)) {
      fail(`${msg}. Is the Anchor CLI installed and on your PATH?`);
    }
    fail(msg);
  }

  const elapsedMs = Math.round(performance.now() - started);

  const json: DeployJson = {
    programId: result.programId.toBase58(),
    deploySignature: result.deploySignature,
    entryIndex: result.entryIndex,
    cluster: cluster.name,
    elapsedMs,
    mock: result.mock,
  };

  if (isJsonMode()) {
    console.log(JSON.stringify(json));
    return;
  }

  logger.success("\nDeploy complete\n");
  console.log(`  Program ID:        ${chalk.bold(result.programId.toBase58())}`);
  console.log(`  Deploy signature:  ${chalk.bold(result.deploySignature)}`);
  if (result.chainSignature && result.mock) {
    console.log(`  Chain signature:   ${chalk.dim(result.chainSignature)}`);
  }
  console.log(`  Entry index:       ${result.entryIndex}`);
  console.log(`  Cluster:           ${cluster.name} (${chalk.dim(cluster.rpcUrl)})`);
  console.log(`  Elapsed:           ${chalk.bold(formatElapsed(elapsedMs))}`);
  console.log();
}

export const deployCommand = new Command("deploy")
  .description("Deploy an Anchor program to the active cluster")
  .option("--json", "output results as JSON")
  .option("--ci", "disable spinners/colors, force JSON-safe output")
  .option("--yes, -y", "skip confirmation prompt")
  .action(async (opts: { json?: boolean; ci?: boolean; yes?: boolean }) => {
    if (opts.json) process.env.BAKE_JSON = "true";
    if (opts.ci) process.env.BAKE_CI = "true";
    if (opts.yes) process.env.BAKE_YES = "true";
    await runDeploy();
  });
