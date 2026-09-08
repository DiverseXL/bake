import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fail } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import {
  getRecipeBookClient,
  isMockRecipeBookClient,
  type RecipeBookClient,
  type RecipeBookEntry,
} from "../lib/recipeBook.js";
import { resolveProgramIdFromAnchorProject } from "../lib/anchorProject.js";
import { runDeployPipeline } from "../lib/deployPipeline.js";
import {
  checkoutCommit,
  commitExists,
  getCurrentBranch,
  getCurrentCommit,
  isGitClean,
  restoreGitState,
} from "../lib/git.js";

// ---------------------------------------------------------------------------
// Helpers
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

function startStep(text: string): {
  succeed: (msg?: string) => void;
  fail: (msg?: string) => void;
} {
  if (isJsonMode()) return { succeed() {}, fail() {} };
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

function promptConfirmation(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(`${message} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

function shortCommit(commit: string): string {
  return commit.length > 8 ? commit.slice(0, 8) : commit;
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Core rollback logic
// ---------------------------------------------------------------------------

interface RollbackResult {
  rolledBackToEntry: number;
  rolledBackToCommit: string;
  newEntryIndex: number;
  deploySignature: string;
}

async function runRollback(entryIndexArg?: number): Promise<RollbackResult> {
  // ── 0. Locate Anchor project ─────────────────────────────────────────────
  const cwd = existsSync(join(process.cwd(), "Anchor.toml"))
    ? process.cwd()
    : join(process.cwd(), "anchor");
  const tomlPath = join(cwd, "Anchor.toml");
  if (!existsSync(tomlPath)) {
    fail("No Anchor.toml found — run this from your program's root directory.");
  }

  // ── 1. Fetch Recipe Book entries ─────────────────────────────────────────
  const programId = resolveProgramIdFromAnchorProject(cwd);
  if (!programId) {
    fail("No program ID found in the Anchor project.");
  }

  const client = getRecipeBookClient();
  const mock = isMockRecipeBookClient(client);

  const entriesStep = startStep("Fetching Recipe Book entries");
  let entries: RecipeBookEntry[];
  try {
    entries = await client.getEntries(programId);
    entriesStep.succeed(`Found ${entries.length} deploy(s) in Recipe Book`);
  } catch (err) {
    entriesStep.fail("Failed to fetch Recipe Book entries");
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Could not read Recipe Book: ${msg}`);
  }

  // ── 2. Determine target entry ────────────────────────────────────────────
  let targetIndex: number;
  if (entryIndexArg !== undefined) {
    // Explicit index supplied
    targetIndex = entryIndexArg;
    if (targetIndex < 0 || targetIndex >= entries.length) {
      fail(
        `Entry #${targetIndex} does not exist — Recipe Book has entries 0–${entries.length - 1}.`,
      );
    }
  } else {
    // Default: undo the last deploy
    if (entries.length < 2) {
      fail(
        "Nothing to roll back to — only one deploy exists.",
      );
    }
    targetIndex = entries.length - 2;
  }

  const target = entries[targetIndex];

  // ── 3. Validate target commit exists in local git history ────────────────
  const commitStep = startStep(
    `Checking target commit ${shortCommit(target.commit)} exists`,
  );
  const hasCommit = await commitExists(cwd, target.commit);
  if (!hasCommit) {
    commitStep.fail(`Commit ${shortCommit(target.commit)} not found locally`);
    fail(
      `The target commit (${shortCommit(target.commit)}) no longer exists in local git history.\n` +
        `This can happen after a force-push or with a shallow clone. Try fetching full history first.`,
    );
  }
  commitStep.succeed(`Commit ${shortCommit(target.commit)} exists`);

  // ── 4. Check git status is clean ─────────────────────────────────────────
  const cleanStep = startStep("Checking git status");
  const clean = await isGitClean(cwd);
  if (!clean) {
    cleanStep.fail("Git working tree is dirty");
    fail(
      "Your working tree has uncommitted changes. Commit or stash them before rolling back.",
    );
  }
  cleanStep.succeed("Git working tree is clean");

  // ── 5. Record current state ──────────────────────────────────────────────
  const originalCommit = await getCurrentCommit(cwd);
  const originalBranch = await getCurrentBranch(cwd);

  // ── 6. Confirm ───────────────────────────────────────────────────────────
  if (!isCiMode() && !isJsonMode() && !isYesMode()) {
    console.log();
    console.log(`  Target entry:    #${target.index}`);
    console.log(`  Commit:          ${chalk.bold(target.commit)}`);
    console.log(`  Repo:            ${target.repo}`);
    console.log(`  Original deploy: ${chalk.dim(formatTimestamp(target.timestamp))}`);
    console.log();
    const confirmed = await promptConfirmation("Proceed with rollback?");
    if (!confirmed) {
      logger.warn("Rollback cancelled.");
      process.exit(0);
    }
  }

  // ── 7. Checkout target commit, deploy, and restore ───────────────────────
  let result: RollbackResult;
  try {
    const checkoutStep = startStep(
      `Checking out ${shortCommit(target.commit)}`,
    );
    try {
      await checkoutCommit(cwd, target.commit);
      checkoutStep.succeed(`Checked out ${shortCommit(target.commit)}`);
    } catch (err) {
      checkoutStep.fail(`Failed to checkout ${shortCommit(target.commit)}`);
      const msg = err instanceof Error ? err.message : String(err);
      fail(`Could not check out target commit: ${msg}`);
    }

    // Build + deploy + register (reuses the shared pipeline)
    const deployResult = await runDeployPipeline(cwd);

    result = {
      rolledBackToEntry: target.index,
      rolledBackToCommit: target.commit,
      newEntryIndex: deployResult.entryIndex,
      deploySignature: deployResult.deploySignature,
    };
  } finally {
    // ── ALWAYS restore original git state ──────────────────────────────────
    const restoreStep = startStep("Restoring original git state");
    try {
      await restoreGitState(cwd, originalBranch, originalCommit);
      restoreStep.succeed(
        `Restored to ${originalBranch ?? shortCommit(originalCommit)}`,
      );
    } catch (err) {
      restoreStep.fail("Failed to restore original git state");
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        `WARNING: Could not restore git state: ${msg}\n` +
          `You may need to manually run: git checkout ${originalBranch ?? originalCommit}`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const rollbackCommand = new Command("rollback")
  .description(
    "Roll back to a previous program version (rebuild + redeploy from git history)",
  )
  .argument("[entryIndex]", "Recipe Book entry index to roll back to (default: undo last deploy)")
  .option("--json", "output results as JSON")
  .option("--ci", "disable spinners/colors, force JSON-safe output")
  .option("--yes, -y", "skip confirmation prompt")
  .action(async (entryIndexArg: string | undefined, opts: { json?: boolean; ci?: boolean; yes?: boolean }) => {
    if (opts.json) process.env.BAKE_JSON = "true";
    if (opts.ci) process.env.BAKE_CI = "true";
    if (opts.yes) process.env.BAKE_YES = "true";

    // Parse the optional integer argument
    let entryIndex: number | undefined;
    if (entryIndexArg !== undefined) {
      const parsed = Number(entryIndexArg);
      if (!Number.isInteger(parsed)) {
        fail(`Invalid entry index: "${entryIndexArg}" — expected a whole number.`);
      }
      entryIndex = parsed;
    }

    try {
      const result = await runRollback(entryIndex);

      if (isJsonMode()) {
        console.log(JSON.stringify(result));
        return;
      }

      logger.success("\nRollback complete\n");
      console.log(`  Rolled back to:  #${result.rolledBackToEntry} (${shortCommit(result.rolledBackToCommit)})`);
      console.log(`  New entry:       #${result.newEntryIndex}`);
      console.log(`  Deploy signature: ${result.deploySignature}`);
      console.log();
    } catch (err) {
      // Already handled via fail() in most cases; catch anything unexpected
      const msg = err instanceof Error ? err.message : String(err);
      fail(`Rollback failed: ${msg}`);
    }
  });
