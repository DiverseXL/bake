import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { getActiveCluster, getConnection } from "./connection.js";
import { getWalletPath, loadLocalWallet } from "./wallet.js";
import { getRecipeBookClient, isMockRecipeBookClient } from "./recipeBook.js";
import {
  resolveProgramIdFromAnchorProject,
  resolveProgramName,
} from "./anchorProject.js";
import { runAnchorBuild, runToolchainCommand } from "./toolchain.js";
import { getCurrentCommit, getGitRemote } from "./git.js";
import { logger } from "./logger.js";

/** BPFLoaderUpgradeab1e — the upgradeable BPF loader all Anchor programs use. */
const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

/** Number of metadata bytes at the start of a ProgramData account. */
const PROGRAM_DATA_HEADER_BYTES = 44;

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
  await runToolchainOrThrow("anchor", ["build", "--arch", "v0", "--tools-version", "v1.57"], cwd);

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
  const deploy = await runToolchainOrThrow("anchor", ["deploy"], cwd, {
    ANCHOR_PROVIDER_URL: cluster.rpcUrl,
    ANCHOR_WALLET: walletPath,
  });
  const chainSignature = parseSignature(`${deploy.stdout}\n${deploy.stderr}`);

  const buildHash = new Uint8Array(
    createHash("sha256").update(readFileSync(soPath)).digest(),
  );
  const commit = await getCurrentCommit(cwd);
  const repo = (await getGitRemote(cwd)).slice(0, 200);
  const client = getRecipeBookClient();
  const mock = isMockRecipeBookClient(client);
  if (!(await client.recipeBookExists(programId))) {
    await client.initializeRecipeBook(programId, wallet);
  }
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

// ---------------------------------------------------------------------------
// Shared helpers used by deploy, rollback, and prove
// ---------------------------------------------------------------------------

/** Convert a Uint8Array to a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Hash a .so file with sha256 and return the hex-encoded digest. */
export function hashFile(soPath: string): string {
  const bytes = readFileSync(soPath);
  return bytesToHex(new Uint8Array(createHash("sha256").update(bytes).digest()));
}

/**
 * Fetch the currently deployed on-chain bytecode for `programId` and return
 * its sha256 hash as a hex string.
 *
 * For upgradeable BPF programs the executable bytecode lives in a separate
 * ProgramData account (a PDA derived from the program ID). The first 44 bytes
 * of that account are metadata (slot + upgrade-authority COption), which we
 * skip before hashing.
 */
export async function fetchOnChainBytecodeHash(
  programId: PublicKey,
): Promise<string> {
  const connection = getConnection();
  const [programDataAddress] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE,
  );
  const accountInfo = await connection.getAccountInfo(programDataAddress);
  if (!accountInfo) {
    throw new Error(
      `ProgramData account not found for ${programId.toBase58()}. ` +
        "Is the program deployed and upgradeable?",
    );
  }
  const bytecode = accountInfo.data.subarray(PROGRAM_DATA_HEADER_BYTES);
  return bytesToHex(
    new Uint8Array(createHash("sha256").update(bytecode).digest()),
  );
}
