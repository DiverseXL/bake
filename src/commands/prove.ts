import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fail } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import {
  getRecipeBookClient,
  isMockRecipeBookClient,
  type RecipeBookEntry,
} from "../lib/recipeBook.js";
import { resolveProgramIdFromAnchorProject } from "../lib/anchorProject.js";
import {
  bytesToHex,
  fetchOnChainBytecodeHash,
  hashFile,
} from "../lib/deployPipeline.js";
import {
  runAnchorBuild,
  type ToolchainResult,
} from "../lib/toolchain.js";
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

function shortCommit(commit: string): string {
  return commit.length > 8 ? commit.slice(0, 8) : commit;
}

function shortHash(hex: string): string {
  return hex.length > 16 ? hex.slice(0, 16) + "…" : hex;
}

// ---------------------------------------------------------------------------
// JSON output shape
// ---------------------------------------------------------------------------

interface ProveJson {
  entryIndex: number;
  commit: string;
  repo: string;
  recordedHash: string;
  onChainHash: string;
  onChainMatch: boolean;
  rebuiltHash: string | null;
  rebuildMatch: boolean | null;
  fullyVerified: boolean;
}

// ---------------------------------------------------------------------------
// Core prove logic
// ---------------------------------------------------------------------------

async function runProve(
  entryIndexArg?: number,
  doRebuild = false,
): Promise<ProveJson> {
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

  // ── 2. Determine target entry ────────────────────────────────────────────
  let targetIndex: number;
  if (entryIndexArg !== undefined) {
    targetIndex = entryIndexArg;
    if (targetIndex < 0 || targetIndex >= entries.length) {
      fail(
        `Entry #${targetIndex} does not exist — Recipe Book has entries 0–${entries.length - 1}.`,
      );
    }
  } else {
    if (entries.length === 0) {
      fail("No Recipe Book entries exist — deploy something first.");
    }
    targetIndex = entries.length - 1;
  }

  const target = entries[targetIndex];
  const recordedHashHex = bytesToHex(target.buildHash);

  // ── 3. Level 1 — on-chain bytecode check ─────────────────────────────────
  const onChainStep = startStep("Fetching on-chain bytecode");
  let onChainHashHex: string;
  try {
    onChainHashHex = await fetchOnChainBytecodeHash(programId);
    onChainStep.succeed("Fetched on-chain bytecode");
  } catch (err) {
    onChainStep.fail("Failed to fetch on-chain bytecode");
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Could not read on-chain program data: ${msg}`);
  }

  const onChainMatch = recordedHashHex === onChainHashHex;

  if (!isJsonMode()) {
    console.log();
    console.log(
      `  Entry #${target.index}  (${shortCommit(target.commit)})`,
    );
    console.log(`  Repo:    ${target.repo}`);
    console.log(`  Deployed: ${new Date(target.timestamp * 1000).toISOString()}`);
    console.log();
    console.log(`  Recorded hash: ${chalk.dim(recordedHashHex)}`);
    console.log(`  On-chain hash: ${chalk.dim(onChainHashHex)}`);
    if (onChainMatch) {
      console.log(
        `  ${chalk.green("✔")} On-chain bytecode matches Recipe Book entry #${target.index} (commit ${shortCommit(target.commit)})`,
      );
    } else {
      console.log(
        `  ${chalk.red("✘ MISMATCH")} — on-chain bytecode does NOT match entry #${target.index}'s recorded hash.`,
      );
      console.log(
        chalk.red(
          "    Someone deployed something different than what's recorded.",
        ),
      );
    }
  }

  // ── 4. Level 2 — rebuild check (--rebuild) ───────────────────────────────
  let rebuiltHashHex: string | null = null;
  let rebuildMatch: boolean | null = null;

  if (doRebuild) {
    // Validate commit exists locally
    const commitStep = startStep(
      `Checking commit ${shortCommit(target.commit)} exists`,
    );
    const hasCommit = await commitExists(cwd, target.commit);
    if (!hasCommit) {
      commitStep.fail(`Commit ${shortCommit(target.commit)} not found locally`);
      fail(
        `The target commit (${shortCommit(target.commit)}) no longer exists in local git history.\n` +
          "This can happen after a force-push or with a shallow clone. Try fetching full history first.",
      );
    }
    commitStep.succeed(`Commit ${shortCommit(target.commit)} exists`);

    // Check git is clean
    const cleanStep = startStep("Checking git status");
    const clean = await isGitClean(cwd);
    if (!clean) {
      cleanStep.fail("Git working tree is dirty");
      fail(
        "Your working tree has uncommitted changes. Commit or stash them before running --rebuild.",
      );
    }
    cleanStep.succeed("Git working tree is clean");

    const originalCommit = await getCurrentCommit(cwd);
    const originalBranch = await getCurrentBranch(cwd);

    try {
      // Checkout the recorded commit
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

      // Build
      const buildStep = startStep("Building from source (anchor build)");
      try {
        const result: ToolchainResult = await runAnchorBuild(cwd);
        if (result.exitCode !== 0) {
          throw new Error(
            `anchor build failed with exit code ${result.exitCode}\n${result.stderr || result.stdout}`,
          );
        }
        buildStep.succeed("Build complete");
      } catch (err) {
        buildStep.fail("Build failed");
        const msg = err instanceof Error ? err.message : String(err);
        fail(`Build failed: ${msg}`);
      }

      // Hash the rebuilt .so
      const soPath = join(cwd, "target", "deploy", "recipe_book.so");
      if (!existsSync(soPath)) {
        fail("Build completed but the .so artifact is missing.");
      }
      rebuiltHashHex = hashFile(soPath);

      rebuildMatch = rebuiltHashHex === recordedHashHex;
      const onChainRebuildMatch = rebuiltHashHex === onChainHashHex;

      if (!isJsonMode()) {
        console.log();
        console.log(`  Rebuilt hash:   ${chalk.dim(rebuiltHashHex)}`);
        if (rebuildMatch) {
          console.log(
            `  ${chalk.green("✔")} Rebuilt hash matches recorded hash`,
          );
        } else {
          console.log(
            `  ${chalk.red("✘ MISMATCH")} — rebuilt hash does NOT match recorded hash`,
          );
        }
        if (onChainRebuildMatch) {
          console.log(
            `  ${chalk.green("✔")} Rebuilt hash matches on-chain hash`,
          );
        } else {
          console.log(
            `  ${chalk.red("✘ MISMATCH")} — rebuilt hash does NOT match on-chain hash`,
          );
        }
        // Summary
        if (onChainMatch && rebuildMatch && onChainRebuildMatch) {
          console.log();
          console.log(
            chalk.green("  All three hashes match — full reproducibility proof ✓"),
          );
        } else {
          console.log();
          console.log(
            chalk.red("  Hashes diverge — reproducibility cannot be confirmed"),
          );
        }
      }
    } finally {
      // ALWAYS restore original git state
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
  }

  const fullyVerified =
    onChainMatch && (doRebuild ? rebuildMatch === true : false);

  return {
    entryIndex: target.index,
    commit: target.commit,
    repo: target.repo,
    recordedHash: recordedHashHex,
    onChainHash: onChainHashHex,
    onChainMatch,
    rebuiltHash: rebuiltHashHex,
    rebuildMatch,
    fullyVerified,
  };
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const proveCommand = new Command("prove")
  .description(
    "Verify that on-chain bytecode matches Recipe Book records (and optionally rebuild from source)",
  )
  .argument(
    "[entryIndex]",
    "Recipe Book entry index to verify (default: most recent)",
  )
  .option("--json", "output results as JSON")
  .option("--ci", "disable spinners/colors, force JSON-safe output")
  .option("--rebuild", "also rebuild from the recorded commit and compare hashes")
  .action(
    async (
      entryIndexArg: string | undefined,
      opts: { json?: boolean; ci?: boolean; rebuild?: boolean },
    ) => {
      if (opts.json) process.env.BAKE_JSON = "true";
      if (opts.ci) process.env.BAKE_CI = "true";

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
        const result = await runProve(entryIndex, opts.rebuild ?? false);

        if (isJsonMode()) {
          console.log(JSON.stringify(result));
          return;
        }

        console.log();
        if (result.fullyVerified) {
          logger.success("Full verification passed — on-chain bytecode is reproducible from source.\n");
        } else if (result.onChainMatch) {
          logger.success("Level 1 passed — on-chain bytecode matches Recipe Book entry.\n");
        } else {
          logger.error("Verification failed — on-chain bytecode does NOT match.\n");
        }

        // Exit with non-zero if any performed check failed
        if (!result.onChainMatch || (result.rebuildMatch !== null && !result.rebuildMatch)) {
          process.exit(1);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fail(`Prove failed: ${msg}`);
      }
    },
  );
