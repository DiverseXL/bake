import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createInterface } from "node:readline";
import { fail } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import {
  getRecipeBookClient,
  isMockRecipeBookClient,
  type RecipeBookEntry,
} from "../lib/recipeBook.js";
import { resolveProgramIdFromAnchorProject } from "../lib/anchorProject.js";
import {
  resolveAnchorProjectCwd,
  runRollbackPipeline,
} from "../lib/rollbackPipeline.js";
import {
  commitExists,
  getCurrentCommit,
  getCurrentBranch,
  isGitClean,
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
// Command
// ---------------------------------------------------------------------------

export const rollbackCommand = new Command("rollback")
  .description(
    "Roll back to a previous program version (rebuild + redeploy from git history)",
  )
  .argument(
    "[entryIndex]",
    "Recipe Book entry index to roll back to (default: undo last deploy)",
  )
  .option("--json", "output results as JSON")
  .option("--ci", "disable spinners/colors, force JSON-safe output")
  .option("--yes", "skip confirmation prompt")
  .action(
    async (
      entryIndexArg: string | undefined,
      opts: { json?: boolean; ci?: boolean; yes?: boolean },
    ) => {
      if (opts.json) process.env.BAKE_JSON = "true";
      if (opts.ci) process.env.BAKE_CI = "true";
      if (opts.yes) process.env.BAKE_YES = "true";

      let entryIndex: number | undefined;
      if (entryIndexArg !== undefined) {
        const parsed = Number(entryIndexArg);
        if (!Number.isInteger(parsed)) {
          fail(
            `Invalid entry index: "${entryIndexArg}" — expected a whole number.`,
          );
        }
        entryIndex = parsed;
      }

      try {
        let cwd: string;
        try {
          cwd = resolveAnchorProjectCwd();
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }

        const programId = resolveProgramIdFromAnchorProject(cwd);
        if (!programId) {
          fail("No program ID found in the Anchor project.");
        }

        const client = getRecipeBookClient();
        const mock = isMockRecipeBookClient(client);

        const entriesStep = startStep("Fetching Recipe Book entries");
        let entries: RecipeBookEntry[];
        try {
          const raw = await client.getEntries(programId);
          entries = raw.sort((a, b) => a.index - b.index);
          entriesStep.succeed(`Found ${entries.length} deploy(s) in Recipe Book`);
        } catch (err) {
          entriesStep.fail("Failed to fetch Recipe Book entries");
          const msg = err instanceof Error ? err.message : String(err);
          fail(`Could not read Recipe Book: ${msg}`);
        }

        let targetIndex: number;
        if (entryIndex !== undefined) {
          targetIndex = entryIndex;
          if (targetIndex < 0 || targetIndex >= entries.length) {
            fail(
              `Entry #${targetIndex} does not exist — Recipe Book has entries 0–${entries.length - 1}.`,
            );
          }
        } else {
          if (entries.length < 2) {
            fail("Nothing to roll back to — only one deploy exists.");
          }
          targetIndex = entries.length - 2;
        }

        const target = entries[targetIndex];

        const commitStep = startStep(
          `Checking target commit ${shortCommit(target.commit)} exists`,
        );
        if (!(await commitExists(cwd, target.commit))) {
          commitStep.fail(`Commit ${shortCommit(target.commit)} not found locally`);
          fail(
            `The target commit (${shortCommit(target.commit)}) no longer exists in local git history.\n` +
              `This can happen after a force-push or with a shallow clone. Try fetching full history first.`,
          );
        }
        commitStep.succeed(`Commit ${shortCommit(target.commit)} exists`);

        const cleanStep = startStep("Checking git status");
        if (!(await isGitClean(cwd))) {
          cleanStep.fail("Git working tree is dirty");
          fail(
            "Your working tree has uncommitted changes. Commit or stash them before rolling back.",
          );
        }
        cleanStep.succeed("Git working tree is clean");

        // Pre-read for messaging only — pipeline also records/restores.
        await getCurrentCommit(cwd);
        await getCurrentBranch(cwd);

        if (!isCiMode() && !isJsonMode() && !isYesMode()) {
          console.log();
          console.log(`  Target entry:    #${target.index}`);
          console.log(`  Commit:          ${chalk.bold(target.commit)}`);
          console.log(`  Repo:            ${target.repo}`);
          console.log(
            `  Original deploy: ${chalk.dim(formatTimestamp(target.timestamp))}`,
          );
          if (mock) {
            console.log(chalk.dim("  (mock Recipe Book)"));
          }
          console.log();
          const confirmed = await promptConfirmation("Proceed with rollback?");
          if (!confirmed) {
            logger.warn("Rollback cancelled.");
            process.exit(0);
          }
        }

        const pipelineStep = startStep(
          `Rolling back to entry #${target.index} (${shortCommit(target.commit)})`,
        );
        const result = await runRollbackPipeline(cwd, entryIndex);
        pipelineStep.succeed(
          `Rolled back to #${result.rolledBackToEntry}; new entry #${result.newEntryIndex}`,
        );

        if (isJsonMode()) {
          console.log(
            JSON.stringify({
              rolledBackToEntry: result.rolledBackToEntry,
              rolledBackToCommit: result.rolledBackToCommit,
              newEntryIndex: result.newEntryIndex,
              deploySignature: result.deploySignature,
            }),
          );
          return;
        }

        logger.success("\nRollback complete\n");
        console.log(
          `  Rolled back to:  #${result.rolledBackToEntry} (${shortCommit(result.rolledBackToCommit)})`,
        );
        console.log(`  New entry:       #${result.newEntryIndex}`);
        console.log(`  Deploy signature: ${result.deploySignature}`);
        console.log();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fail(`Rollback failed: ${msg}`);
      }
    },
  );
