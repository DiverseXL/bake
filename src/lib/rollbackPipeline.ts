/**
 * Shared rollback pipeline — git checkout → runDeployPipeline → restore.
 * Used by `bake rollback` and MCP write tools. MUST restore git state in finally
 * (AGENTS.md §2.5). Does not prompt; callers own confirmation UX.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type PublicKey } from "@solana/web3.js";
import { resolveProgramIdFromAnchorProject } from "./anchorProject.js";
import { runDeployPipeline } from "./deployPipeline.js";
import {
  checkoutCommit,
  commitExists,
  getCurrentBranch,
  getCurrentCommit,
  isGitClean,
  restoreGitState,
} from "./git.js";
import {
  getRecipeBookClient,
  type RecipeBookEntry,
} from "./recipeBook.js";

export interface RollbackPipelineResult {
  rolledBackToEntry: number;
  rolledBackToCommit: string;
  newEntryIndex: number;
  deploySignature: string;
  programId: string;
}

function shortCommit(commit: string): string {
  return commit.length > 8 ? commit.slice(0, 8) : commit;
}

export function resolveAnchorProjectCwd(cwd = process.cwd()): string {
  if (existsSync(join(cwd, "Anchor.toml"))) return cwd;
  const nested = join(cwd, "anchor");
  if (existsSync(join(nested, "Anchor.toml"))) return nested;
  throw new Error(
    "No Anchor.toml found — run this from your program's root directory.",
  );
}

/**
 * Run the rollback pipeline.
 *
 * @param cwd         Working directory (used for git operations and build).
 * @param entryIndex  Recipe Book entry index to roll back to (optional).
 * @param programId   Program ID override (e.g. from --program flag).
 *                    When provided, Anchor.toml detection is skipped entirely —
 *                    the cwd is used only for git operations and the build.
 *                    When omitted, falls back to resolveProgramIdFromAnchorProject().
 */
export async function runRollbackPipeline(
  cwd: string,
  entryIndexArg?: number,
  programId?: PublicKey,
): Promise<RollbackPipelineResult> {
  // If --program was passed, skip Anchor.toml resolution entirely.
  // The cwd is still used for git checkout/deploy, but we don't require
  // an Anchor project structure — just a valid git repo.
  let projectCwd: string;
  let resolvedProgramId: PublicKey;

  if (programId) {
    projectCwd = cwd;
    resolvedProgramId = programId;
  } else {
    projectCwd = resolveAnchorProjectCwd(cwd);
    const resolved = resolveProgramIdFromAnchorProject(projectCwd);
    if (!resolved) {
      throw new Error("No program ID found in the Anchor project.");
    }
    resolvedProgramId = resolved;
  }

  const client = getRecipeBookClient();
  const raw = await client.getEntries(resolvedProgramId);
  const entries: RecipeBookEntry[] = raw.sort((a, b) => a.index - b.index);

  let targetIndex: number;
  if (entryIndexArg !== undefined) {
    targetIndex = entryIndexArg;
    if (targetIndex < 0 || targetIndex >= entries.length) {
      throw new Error(
        `Entry #${targetIndex} does not exist — Recipe Book has entries 0–${Math.max(0, entries.length - 1)}.`,
      );
    }
  } else {
    if (entries.length < 2) {
      throw new Error("Nothing to roll back to — only one deploy exists.");
    }
    targetIndex = entries.length - 2;
  }

  const target = entries[targetIndex];

  const hasCommit = await commitExists(projectCwd, target.commit);
  if (!hasCommit) {
    throw new Error(
      `The target commit (${shortCommit(target.commit)}) no longer exists in local git history.\n` +
        `This can happen after a force-push or with a shallow clone. Try fetching full history first.`,
    );
  }

  const clean = await isGitClean(projectCwd);
  if (!clean) {
    throw new Error(
      "Your working tree has uncommitted changes. Commit or stash them before rolling back.",
    );
  }

  const originalCommit = await getCurrentCommit(projectCwd);
  const originalBranch = await getCurrentBranch(projectCwd);

  try {
    await checkoutCommit(projectCwd, target.commit);
    const deployResult = await runDeployPipeline(projectCwd);
    return {
      rolledBackToEntry: target.index,
      rolledBackToCommit: target.commit,
      newEntryIndex: deployResult.entryIndex,
      deploySignature: deployResult.deploySignature,
      programId: resolvedProgramId.toBase58(),
    };
  } finally {
    try {
      await restoreGitState(projectCwd, originalBranch, originalCommit);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Rollback deploy may have completed, but git state could not be restored: ${msg}\n` +
          `You may need to manually run: git checkout ${originalBranch ?? originalCommit}`,
      );
    }
  }
}
