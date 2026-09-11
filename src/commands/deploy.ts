import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { fail } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { getActiveCluster } from "../lib/connection.js";
import { runDeployPipeline } from "../lib/deployPipeline.js";
import { resolveAnchorProjectRoot } from "../lib/anchorProject.js";
import {
  formatFindingsList,
  runRadarAudit,
  summarizeFindings,
  type RadarAuditResult,
} from "../lib/radarAudit.js";

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

/**
 * `deploy --require-audit` gate — run Radar before deploying and refuse if any
 * critical/high finding is reported.
 *
 * This is an opt-in gate, and deliberately has NO `--ignore-audit` escape
 * hatch: passing the gate flag and then overriding the gate is the exact
 * failure mode the flag exists to prevent. To deploy anyway, omit the flag.
 */
async function runAuditGate(cwd: string): Promise<void> {
  const step = startStep("Running security audit (powered by Radar)");
  let result: RadarAuditResult;
  try {
    result = await runRadarAudit({ targetPath: cwd });
  } catch (err) {
    step.fail("Audit could not run");
    fail(err instanceof Error ? err.message : String(err));
  }

  if (result.exitCode === 2) {
    step.fail("Audit could not run");
    fail(
      "Refusing to deploy: `bake audit` could not complete (Radar exited 2). " +
        "That is an infrastructure or scan failure, not a clean result.",
    );
  }

  const gating = result.gatingCount > 0 || result.exitCode === 1;
  if (!gating) {
    step.succeed(
      `Audit passed — ${summarizeFindings(result.counts)} — powered by Radar`,
    );
    return;
  }

  step.fail("Audit found high-severity issues");
  const list = formatFindingsList(result.findings);
  fail(
    `Refusing to deploy: ${summarizeFindings(result.counts)} — powered by Radar.\n` +
      (list ? `${list}\n` : "") +
      "Deploy without the audit gate by omitting --require-audit.",
  );
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

async function runDeploy(opts: { requireAudit?: boolean }): Promise<void> {
  const cwd = resolveAnchorProjectRoot();
  if (!cwd) {
    fail("No Anchor.toml found — run this from your program's root directory.");
  }

  if (opts.requireAudit) {
    await runAuditGate(cwd);
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
  .option(
    "--require-audit",
    "run `bake audit` first and refuse to deploy on any critical/high finding",
  )
  .action(
    async (opts: {
      json?: boolean;
      ci?: boolean;
      yes?: boolean;
      requireAudit?: boolean;
    }) => {
      if (opts.json) process.env.BAKE_JSON = "true";
      if (opts.ci) process.env.BAKE_CI = "true";
      if (opts.yes) process.env.BAKE_YES = "true";
      await runDeploy({ requireAudit: opts.requireAudit });
    },
  );
