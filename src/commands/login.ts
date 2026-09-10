import { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "fs";
import { Keypair } from "@solana/web3.js";
import { readGlobalConfig, writeGlobalConfig } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { fail } from "../lib/errors.js";
import { connectNightly } from "../lib/nightly.js";
import { createLocalWallet, resolveWalletPath } from "../lib/wallet.js";

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
    const raw: number[] = JSON.parse(readFileSync(existingPath, "utf-8"));
    const bytes = new Uint8Array(raw);
    if (bytes.length !== 64) {
      fail(`Keypair file at ${existingPath} is not 64 bytes (got ${bytes.length}).`);
    }
    publicKey = Keypair.fromSecretKey(bytes).publicKey.toBase58();
  } else {
    const result = await createLocalWallet();
    walletPath = result.walletPath;
    publicKey = result.publicKey;
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
