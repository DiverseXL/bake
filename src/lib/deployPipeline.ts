import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getActiveCluster } from "./connection.js";
import { getWalletPath, loadLocalWallet } from "./wallet.js";
import { getRecipeBookClient, isMockRecipeBookClient } from "./recipeBook.js";
import {
  resolveProgramIdFromAnchorProject,
  resolveProgramName,
} from "./anchorProject.js";
import { runAnchorBuild, runToolchainCommand } from "./toolchain.js";
import { getCurrentCommit, getGitRemote } from "./git.js";
import { logger } from "./logger.js";

export interface DeployPipelineResult {
  programId: ReturnType<typeof resolveProgramIdFromAnchorProject> extends infer T
    ? Exclude<T, null>
    : never;
  deploySignature: string;
  chainSignature: string | null;
  entryIndex: number;
  mock: boolean;
  commit: string;
  repo: string;
}

function parseSignature(output: string): string | null {
  return (
    output.match(/^\s*Signature:\s+(\S+)/m)?.[1] ??
    output.match(/Program Id:\s+\S+[\s\S]*?Signature:\s+(\S+)/)?.[1] ??
    null
  );
}

async function runToolchainOrThrow(
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const result = await runToolchainCommand(command, args, { cwd, env });
  if (result.exitCode !== 0) {
    throw new Error(
      `\`${[command, ...args].join(" ")}\` failed with exit code ${result.exitCode}\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

export async function runDeployPipeline(cwd: string): Promise<DeployPipelineResult> {
  const tomlPath = join(cwd, "Anchor.toml");
  if (!existsSync(tomlPath)) {
    throw new Error("No Anchor.toml found — run this from your program's root directory.");
  }
  const programName = resolveProgramName(cwd, readFileSync(tomlPath, "utf8"));
  logger.info(`Building ${programName} (anchor build)`);
  console.log(`[debug] anchor build cwd=${cwd}`);
  await runToolchainOrThrow("anchor", ["build", "--arch", "v0", "--tools-version", "v1.57"], cwd);
  console.log(`[debug] anchor build succeeded`);

  const keypairPath = join(cwd, "target", "deploy", `${programName}-keypair.json`);
  const soPath = join(cwd, "target", "deploy", `${programName}.so`);
  if (!existsSync(keypairPath) || !existsSync(soPath)) {
    throw new Error(`Build completed but ${programName}'s deploy artifacts are missing.`);
  }
  const programId = resolveProgramIdFromAnchorProject(cwd);
  if (!programId) {
    throw new Error("No program ID found after building the Anchor project.");
  }

  const cluster = getActiveCluster();
  const wallet = loadLocalWallet();
  const walletPath = getWalletPath();
  logger.info(`Deploying ${programName} to ${cluster.name}`);
  console.log(`[debug] anchor deploy cwd=${cwd}, walletPath=${walletPath}`);
  const deploy = await runToolchainOrThrow("anchor", ["deploy"], cwd, {
    ANCHOR_PROVIDER_URL: cluster.rpcUrl,
    ANCHOR_WALLET: walletPath,
  });
  console.log(`[debug] anchor deploy succeeded, stdout length=${deploy.stdout.length}`);
  const chainSignature = parseSignature(`${deploy.stdout}\n${deploy.stderr}`);

  const buildHash = new Uint8Array(
    createHash("sha256").update(readFileSync(soPath)).digest(),
  );
  const commit = await getCurrentCommit(cwd);
  const repo = (await getGitRemote(cwd)).slice(0, 200);
  const client = getRecipeBookClient();
  const mock = isMockRecipeBookClient(client);
  console.log(`[debug] programId=${programId.toBase58()}, cluster=${cluster.rpcUrl}`);
  console.log(`[debug] checking recipeBookExists...`);
  const bookExists = await client.recipeBookExists(programId);
  console.log(`[debug] recipeBookExists=${bookExists}`);
  if (!bookExists) {
    console.log(`[debug] initializing recipe book...`);
    await client.initializeRecipeBook(programId, wallet);
    console.log(`[debug] recipe book initialized`);
  }
  console.log(`[debug] registering deploy...`);
  const registered = await client.registerDeploy(
    programId,
    { repo, commit: commit.slice(0, 44), buildHash, buffer: programId },
    wallet,
  );
  logger.success(`Registered deploy in Recipe Book (entry #${registered.entryIndex})`);
  return {
    programId,
    deploySignature: mock ? "mock" : registered.signature || chainSignature || "unknown",
    chainSignature,
    entryIndex: registered.entryIndex,
    mock,
    commit,
    repo,
  };
}
