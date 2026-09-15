import { Command } from "commander";
import chalk from "chalk";
import { exec } from "node:child_process";
import { readGlobalConfig } from "../config/index.js";
import { resolveWalletPath } from "../lib/wallet.js";
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { logger } from "../lib/logger.js";

const DASHBOARD_DEFAULT_URL = "https://bakeacookie.vercel.app";

function getDashboardUrl(): string {
  return process.env.BAKE_DASHBOARD_URL || DASHBOARD_DEFAULT_URL;
}

/**
 * Resolve the public key of the local wallet (the same logic `bake whoami`
 * uses to discover the local keypair). Returns null if no wallet exists.
 */
function resolveLocalPublicKey(): string | null {
  const walletPath = resolveWalletPath();
  if (!walletPath) return null;

  try {
    const raw = JSON.parse(readFileSync(walletPath, "utf-8"));
    if (!Array.isArray(raw)) return null;
    const bytes = Uint8Array.from(raw as number[]);
    if (bytes.length !== 64) return null;
    const keypair = Keypair.fromSecretKey(bytes);
    return keypair.publicKey.toBase58();
  } catch {
    return null;
  }
}

/**
 * Open a URL in the default browser, cross-platform.
 * Uses the native OS command: `start` on Windows, `open` on macOS,
 * `xdg-open` on Linux.
 */
function openInBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;

  if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else {
    // Linux / other Unix
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (err) => {
    if (err) {
      logger.warn(
        `Could not open browser automatically. Visit this URL instead:\n  ${chalk.bold(url)}`,
      );
    }
  });
}

interface DashboardOpts {
  wallet?: boolean;
  ci?: boolean;
  json?: boolean;
}

async function runDashboard(
  address: string | undefined,
  opts: DashboardOpts,
): Promise<void> {
  const baseUrl = getDashboardUrl();
  const isJson = process.env.BAKE_JSON === "true";
  const isCi = process.env.BAKE_CI === "true" || opts.ci;

  let url: string;

  if (address) {
    // Explicit address: /program/<address> by default, /wallet/<address> with --wallet
    if (opts.wallet) {
      url = `${baseUrl}/wallet/${address}`;
    } else {
      url = `${baseUrl}/program/${address}`;
    }
  } else {
    // No address: resolve own wallet → /wallet/<own-address>
    const publicKey = resolveLocalPublicKey();
    if (!publicKey) {
      if (isJson) {
        console.log(JSON.stringify({ error: "No local wallet found" }));
      } else {
        logger.warn(
          "No local wallet found. Run `bake login` first, or pass a program/wallet address:\n\n  " +
            chalk.cyan("bake dashboard <address>") +
            "\n  " +
            chalk.cyan("bake dashboard <address> --wallet") +
            "\n",
        );
      }
      process.exit(1);
    }
    url = `${baseUrl}/wallet/${publicKey}`;
  }

  if (isJson) {
    console.log(JSON.stringify({ url }));
    return;
  }

  if (isCi) {
    // CI mode: print URL instead of opening browser
    console.log(url);
    return;
  }

  // Interactive: open browser and print URL for reference
  openInBrowser(url);
  logger.success(`\n  Opening dashboard:\n  ${chalk.bold(url)}\n`);
}

export const dashboardCommand = new Command("dashboard")
  .description(
    "Open the bake dashboard in your browser (bakeacookie.vercel.app)",
  )
  .argument("[address]", "program or wallet address to view")
  .option("--wallet", "open as wallet view instead of program view")
  .option("--ci", "print URL instead of opening browser")
  .option("--json", "output results as JSON")
  .action(
    async (
      address: string | undefined,
      opts: { wallet?: boolean; ci?: boolean; json?: boolean },
    ) => {
      if (opts.json) process.env.BAKE_JSON = "true";
      if (opts.ci) process.env.BAKE_CI = "true";
      await runDashboard(address, opts);
    },
  );
