import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { getRecipeBookClient } from "../lib/recipeBook.js";
import { resolveProgramIdFromAnchorProject } from "../lib/anchorProject.js";
import {
  bytesToHex,
  fetchOnChainBytecodeHash,
  hashFile,
} from "../lib/deployPipeline.js";
import { runAnchorBuild } from "../lib/toolchain.js";
import { getCurrentCommit, commitExists, isGitClean } from "../lib/git.js";
import { resolveProgramName } from "../lib/anchorProject.js";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isJsonMode(): boolean {
  return process.env.BAKE_JSON === "true";
}

function isCiMode(): boolean {
  return process.env.BAKE_CI === "true";
}

function shortCommit(commit: string): string {
  return commit.length > 8 ? commit.slice(0, 8) : commit;
}

function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) =>
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 }),
    );
  });
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

interface DiffJson {
  comparedToEntry: number;
  comparedToCommit: string;
  currentCommit: string;
  workingTreeDirty: boolean;
  filesChanged: string[] | null;
  rebuildPerformed: boolean;
  wouldChangeBytecode: boolean | null;
}

async function runDiff(
  entryIndexArg: number | undefined,
  doRebuild: boolean,
): Promise<DiffJson> {
  const cwd = existsSync(join(process.cwd(), "Anchor.toml"))
    ? process.cwd()
    : join(process.cwd(), "anchor");

  const programId = resolveProgramIdFromAnchorProject(cwd);
  if (!programId) {
    fail(
      "No program ID found — make sure you're in an Anchor project directory.",
    );
  }

  const client = getRecipeBookClient();
  const entries = (await client.getEntries(programId)).sort(
    (a, b) => a.index - b.index,
  );

  if (entries.length === 0) {
    fail("No deploys recorded yet — nothing to diff against.");
  }

  let targetIndex: number;
  if (entryIndexArg !== undefined) {
    targetIndex = entryIndexArg;
    if (targetIndex < 0 || targetIndex >= entries.length) {
      fail(
        `Entry #${targetIndex} does not exist — Recipe Book has entries 0–${entries.length - 1}.`,
      );
    }
  } else {
    targetIndex = entries.length - 1;
  }

  const target = entries[targetIndex];
  const targetCommit = target.commit;

  const currentCommit = await getCurrentCommit(cwd);
  const workingTreeClean = await isGitClean(cwd);

  // ── Source-level diff ──────────────────────────────────────────────────

  let sourceDiffStat = "";
  let commitExistsLocally = false;

  if (await commitExists(cwd, targetCommit)) {
    commitExistsLocally = true;
    const result = await runGit(
      ["diff", "--stat", `${targetCommit}..HEAD`],
      cwd,
    );
    sourceDiffStat = result.stdout;
  }

  let uncommittedStagedStat = "";
  let uncommittedUnstagedStat = "";

  if (!workingTreeClean) {
    const staged = await runGit(["diff", "--stat", "--cached"], cwd);
    uncommittedStagedStat = staged.stdout;

    const unstaged = await runGit(["diff", "--stat"], cwd);
    uncommittedUnstagedStat = unstaged.stdout;
  }

  const sameCommit = currentCommit === targetCommit;

  const filesChanged = commitExistsLocally
    ? sourceDiffStat
        .split("\n")
        .filter((l) => l.trim() && !l.includes("|") === false && l.includes("|"))
        .map((l) => l.trim().split("|")[0].trim())
        .filter(Boolean)
    : null;

  const result: DiffJson = {
    comparedToEntry: target.index,
    comparedToCommit: targetCommit,
    currentCommit,
    workingTreeDirty: !workingTreeClean,
    filesChanged,
    rebuildPerformed: false,
    wouldChangeBytecode: null,
  };

  // ── Bytecode-level check (opt-in via --rebuild) ───────────────────────

  if (doRebuild) {
    const buildResult = await runAnchorBuild(cwd);
    if (buildResult.exitCode !== 0) {
      fail(
        `Anchor build failed:\n${buildResult.stderr || buildResult.stdout}`,
      );
    }

    const tomlContent = readFileSync(join(cwd, "Anchor.toml"), "utf8");
    const soProgramName = resolveProgramName(cwd, tomlContent);
    const soPath = join(cwd, "target", "deploy", `${soProgramName}.so`);

    if (!existsSync(soPath)) {
      fail(
        `Build completed but .so file not found at expected path: ${soPath}`,
      );
    }

    const localHash = hashFile(soPath);
    const onChainHash = await fetchOnChainBytecodeHash(programId);

    result.rebuildPerformed = true;
    result.wouldChangeBytecode = localHash !== onChainHash;
  }

  // ── Human-readable output ─────────────────────────────────────────────

  if (!isJsonMode()) {
    console.log(
      chalk.bold(
        `\nbake diff — entry #${target.index} (${shortCommit(targetCommit)})`,
      ),
    );
    console.log(
      `Current HEAD: ${shortCommit(currentCommit)}${sameCommit ? " (same as deployed)" : ""}`,
    );

    // Source changes
    console.log(chalk.bold("\nSource changes:"));

    if (!commitExistsLocally) {
      logger.warn(
        `Target commit ${shortCommit(targetCommit)} no longer exists locally (force-pushed?).`,
      );
      logger.warn("Cannot compute source diff against this entry.");
    } else if (sameCommit && workingTreeClean) {
      logger.success("No source changes since this deploy.");
    } else {
      const statLines = sourceDiffStat
        .split("\n")
        .filter((l) => l.trim());
      if (statLines.length > 0) {
        for (const line of statLines) {
          console.log(chalk.gray(`  ${line}`));
        }
      } else {
        logger.success("No committed source changes since this deploy.");
      }
    }

    // Uncommitted changes
    if (!workingTreeClean) {
      console.log(chalk.bold("\nUncommitted changes (not yet part of any commit):"));

      const stagedLines = uncommittedStagedStat
        .split("\n")
        .filter((l) => l.trim());
      if (stagedLines.length > 0) {
        console.log(chalk.yellow("  Staged:"));
        for (const line of stagedLines) {
          console.log(chalk.gray(`    ${line}`));
        }
      }

      const unstagedLines = uncommittedUnstagedStat
        .split("\n")
        .filter((l) => l.trim());
      if (unstagedLines.length > 0) {
        console.log(chalk.yellow("  Unstaged:"));
        for (const line of unstagedLines) {
          console.log(chalk.gray(`    ${line}`));
        }
      }

      if (stagedLines.length === 0 && unstagedLines.length === 0) {
        console.log(chalk.gray("  (empty working tree changes)"));
      }
    } else if (commitExistsLocally && !sameCommit) {
      console.log(chalk.gray("\nWorking tree is clean."));
    }

    // Bytecode impact
    if (doRebuild) {
      console.log(chalk.bold("\nBytecode impact:"));
      if (result.wouldChangeBytecode) {
        logger.warn("Deploying now WOULD change the on-chain program.");
      } else {
        logger.success(
          "Deploying now would NOT change the on-chain program (same bytecode hash).",
        );
      }
    }
    console.log("");
  }

  return result;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const diffCommand = new Command("diff")
  .description(
    "Compare local source and bytecode against a deployed Recipe Book entry",
  )
  .argument(
    "[entryIndex]",
    "Recipe Book entry index to compare against (default: most recent)",
  )
  .option("--json", "output results as JSON")
  .option("--ci", "disable colors in output")
  .option(
    "--rebuild",
    "rebuild the program and compare bytecode hashes (slower, opt-in)",
  )
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
        const result = await runDiff(entryIndex, opts.rebuild ?? false);
        if (isJsonMode()) {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isJsonMode()) {
          console.log(JSON.stringify({ error: msg }, null, 2));
        } else {
          fail(msg);
        }
      }
    },
  );
