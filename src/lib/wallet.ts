/**
 * Local keypair loading — shared by `bake login`, `bake deploy`, and any
 * command that needs to sign with the configured wallet.
 *
 * Uses the classic @solana/web3.js v1 `Keypair.fromSecretKey` API so the
 * result can be passed straight into the Recipe Book client.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { createInterface } from "node:readline";
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair } from "@solana/web3.js";
import { getGlobalConfigDir, readGlobalConfig, updateGlobalConfig } from "../config/index.js";
import { fail } from "./errors.js";
import { logger } from "./logger.js";
import chalk from "chalk";


/** Standard Solana CLI keypair location. */
export const SOLANA_CLI_KEYPATH = join(homedir(), ".config", "solana", "id.json");
/** Bake-specific fallback keypair location. */
export const BAKE_KEYPATH = join(getGlobalConfigDir(), "keypair.json");

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Resolve an existing keypair file path, in priority order:
 *   1. walletPath stored in global config
 *   2. ~/.config/solana/id.json  (standard Solana CLI location)
 *   3. ~/.bake/keypair.json      (bake-specific fallback)
 *
 * Returns the resolved absolute path or `null` if none found.
 */
export function resolveWalletPath(): string | null {
  const cfg = readGlobalConfig();
  const candidates = [
    cfg?.walletPath,
    SOLANA_CLI_KEYPATH,
    BAKE_KEYPATH,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const p of candidates) {
    const expanded = expandHome(p);
    const abs = isAbsolute(expanded) ? expanded : resolve(expanded);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/** Absolute path to the local wallet file. Fails if none is configured. */
export function getWalletPath(): string {
  const path = resolveWalletPath();
  if (!path) {
    fail("No local wallet found. Run `bake login` to set one up.");
  }
  return path;
}

/**
 * Generate a brand-new ed25519 keypair, save it to BAKE_KEYPATH with
 * restrictive permissions, persist the path in global config, and return
 * the public key and wallet path.
 *
 * This is the single source of truth for wallet creation — used by both
 * `bake login` and the inline first-run prompt.
 */
export async function createLocalWallet(): Promise<{ publicKey: string; walletPath: string }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pubKey = ed25519.getPublicKey(seed);

  const keypairBytes = new Uint8Array(64);
  keypairBytes.set(seed, 0);
  keypairBytes.set(pubKey, 32);

  const dir = join(BAKE_KEYPATH, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(BAKE_KEYPATH, JSON.stringify(Array.from(keypairBytes)), "utf-8");

  try {
    chmodSync(BAKE_KEYPATH, 0o600);
  } catch {
    // Windows doesn't support chmod; ignore silently.
  }

  // Verify by loading it back.
  const publicKey = Keypair.fromSecretKey(keypairBytes).publicKey.toBase58();

  // Persist walletPath to global config (read-modify-write under the lock).
  updateGlobalConfig((data) => {
    data.walletPath = BAKE_KEYPATH;
  });

  return { publicKey, walletPath: BAKE_KEYPATH };
}

/**
 * Load the local keypair from disk via `Keypair.fromSecretKey`.
 *
 * If no wallet is found and this is an interactive session (not --ci/--json),
 * prompts the user to create one inline instead of failing immediately.
 * Fails with a friendly error if the file is missing or malformed, or if
 * the user declines the prompt / is in a non-interactive context.
 */
export async function loadLocalWallet(): Promise<Keypair> {
  const path = resolveWalletPath();

  if (!path) {
    const isCi = process.env.BAKE_CI === "true";
    const isJson = process.env.BAKE_JSON === "true";
    const isInteractive = process.stdout.isTTY === true && !isCi && !isJson;

    if (isInteractive) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = await new Promise<string>((resolve) => {
        rl.question(chalk.bold("No wallet found — create one now? [Y/n] "), (a) => {
          rl.close();
          resolve(a);
        });
      });

      if (answer.trim() === "" || answer.trim().toLowerCase() === "y") {
        const { publicKey, walletPath } = await createLocalWallet();
        logger.success(`\nGenerated new keypair: ${chalk.bold(publicKey)}`);
        logger.info(`  Saved to: ${walletPath}\n`);
      } else {
        logger.info("\nNo problem — run `bake login` whenever you're ready.\n");
        process.exit(1);
      }
    } else {
      fail("No local wallet found. Run `bake login` to set one up.");
    }
  }

  // (Re-)resolve in case we just created one.
  const resolvedPath = getWalletPath();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolvedPath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Failed to load wallet at ${resolvedPath}: ${msg}`);
  }
  if (!Array.isArray(raw) || !raw.every((n) => typeof n === "number")) {
    fail(`Keypair file at ${resolvedPath} is not a JSON array of numbers.`);
  }
  const bytes = Uint8Array.from(raw as number[]);
  if (bytes.length !== 64) {
    fail(`Keypair file at ${resolvedPath} is not 64 bytes (got ${bytes.length}).`);
  }
  try {
    return Keypair.fromSecretKey(bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Failed to load wallet at ${resolvedPath}: ${msg}`);
  }
}
