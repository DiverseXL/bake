import { spawn } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runGit(args: string[], cwd: string): Promise<GitResult> {
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

export async function getCurrentCommit(cwd: string): Promise<string> {
  const result = await runGit(["rev-parse", "HEAD"], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to determine the current git commit: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const result = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function getGitRemote(cwd: string): Promise<string> {
  const result = await runGit(["remote", "get-url", "origin"], cwd);
  return result.exitCode === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : "local";
}

export async function isGitClean(cwd: string): Promise<boolean> {
  const result = await runGit(["status", "--porcelain"], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to inspect git status: ${result.stderr.trim()}`);
  }
  return result.stdout.trim().length === 0;
}

export async function commitExists(cwd: string, commit: string): Promise<boolean> {
  const result = await runGit(["cat-file", "-e", `${commit}^{commit}`], cwd);
  return result.exitCode === 0;
}

export async function checkoutCommit(cwd: string, commit: string): Promise<void> {
  const result = await runGit(["checkout", "--detach", commit], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to check out ${commit}: ${result.stderr.trim()}`);
  }
}

export async function restoreGitState(
  cwd: string,
  branch: string | null,
  commit: string,
): Promise<void> {
  const result = branch
    ? await runGit(["checkout", branch], cwd)
    : await runGit(["checkout", "--detach", commit], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to restore the original git state: ${result.stderr.trim()}`);
  }
}
