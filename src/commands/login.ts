import { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair } from "@solana/web3.js";
import { readGlobalConfig, writeGlobalConfig } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { fail } from "../lib/errors.js";
import { connectNightly } from "../lib/nightly.js";
import { BAKE_KEYPATH, resolveWalletPath } from "../lib/wallet.js";

/**
 * Load a 64-byte keypair file (JSON array of numbers) and return the
 * base58-encoded public key.
 */
async function loadPublicKeyFromFile(path: string): Promise<string> {
  const raw: number[] = JSON.parse(readFileSync(path, "utf-8"));
  const bytes = new Uint8Array(raw);
  if (bytes.length !== 64) {
    fail(`Keypair file at ${path} is not 64 bytes (got ${bytes.length}).`);
  }
  return Keypair.fromSecretKey(bytes).publicKey.toBase58();
}

/**
 * Generate a brand-new ed25519 keypair, save it to the given path with
 * restrictive permissions, and return the base58 public key.
 */
async function generateAndSaveKeypair(path: string): Promise<string> {
  // Generate a 32-byte random seed (like Solana CLI does).
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pubKey = ed25519.getPublicKey(seed);

  // 64-byte keypair format: [seed(32) | pubKey(32)]
  const keypairBytes = new Uint8Array(64);
  keypairBytes.set(seed, 0);
  keypairBytes.set(pubKey, 32);

  // Ensure the parent directory exists.
  const dir = join(path, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(path, JSON.stringify(Array.from(keypairBytes)), "utf-8");

  // Best-effort restrictive permissions (0600) — works on POSIX, no-op on Windows.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows doesn't support chmod; ignore silently.
  }

  // Verify by loading it back.
  return loadPublicKeyFromFile(path);
}

// ---------------------------------------------------------------------------
// Command implementation
// ---------------------------------------------------------------------------

async function runLogin(opts: { wallet?: string }): Promise<void> {
  const isJson = process.env.BAKE_JSON === "true";

  // --- Nightly Connect path -------------------------------------------
  if (opts.wallet === "nightly") {
    try {
      const result = await connectNightly();

      // Persist to global config (does NOT overwrite walletPath).
      const existing = readGlobalConfig();
      const data: Record<string, unknown> = existing ? { ...existing } : {};
      data.nightlyWallet = {
        publicKey: result.publicKey,
        sessionId: result.sessionId,
      };
      writeGlobalConfig(data);

      if (isJson) {
        console.log(
          JSON.stringify({
            publicKey: result.publicKey,
            sessionId: result.sessionId,
            wallet: "nightly",
          }),
        );
      } else {
        logger.success(
          `\nNightly Connect wallet linked: ${chalk.bold(result.publicKey)}\n`,
        );
        logger.info(
          "  This wallet is stored for high-stakes confirmations (e.g. deploy --confirm nightly).\n" +
            "  It does NOT replace your local keypair.\n",
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Nightly Connect failed";
      fail(msg);
    }
    return;
  }

  // --- Default local keypair path -------------------------------------
  const existingPath = resolveWalletPath();
  let walletPath: string;
  let publicKey: string;
  let created = false;

  if (existingPath) {
    walletPath = existingPath;
    publicKey = await loadPublicKeyFromFile(existingPath);
  } else {
    // Generate a new keypair at ~/.bake/keypair.json
    walletPath = BAKE_KEYPATH;
    publicKey = await generateAndSaveKeypair(BAKE_KEYPATH);
    created = true;
  }

  // Persist walletPath to global config (in case it wasn't set yet).
  const existing = readGlobalConfig();
  const data: Record<string, unknown> = existing ? { ...existing } : {};
  data.walletPath = walletPath;
  writeGlobalConfig(data);

  if (isJson) {
    console.log(JSON.stringify({ publicKey, walletPath, created }));
  } else {
    if (created) {
      logger.success(
        `\nGenerated new keypair: ${chalk.bold(publicKey)}\n`,
      );
      logger.info(`  Saved to: ${walletPath}\n`);
    } else {
      logger.info(
        `\nUsing existing keypair: ${chalk.bold(publicKey)}\n`,
      );
      logger.info(`  Path: ${walletPath}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Export the commander command
// ---------------------------------------------------------------------------

export const loginCommand = new Command("login")
  .description("Set up your Cookie Chain wallet for signing transactions")
  .option("--wallet <type>", "Wallet type: 'local' (default) or 'nightly'")
  .action(async (opts: { wallet?: string }) => {
    await runLogin(opts);
  });
