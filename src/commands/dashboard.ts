import { Command } from "commander";
import chalk from "chalk";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { logger } from "../lib/logger.js";
import { resolveWalletPath } from "../lib/wallet.js";

const DASHBOARD_DEFAULT_URL = "https://bakeacookie.vercel.app";

function getDashboardUrl(): string {
  return process.env.BAKE_DASHBOARD_URL || DASHBOARD_DEFAULT_URL;
}

/**
 * Resolve the public key of the local wallet (same discovery as `bake whoami`).
 * Returns null if no wallet exists or the file cannot be parsed.
 */
function resolveLocalPublicKey(): string | null {
  const walletPath = resolveWalletPath();
  if (!walletPath) return null;
  try {
    const raw = JSON.parse(readFileSync(walletPath, "utf-8"));
    if (!Array.isArray(raw)) return null;
    const bytes = Uint8Array.from(raw);
    if (bytes.length !== 64) return null;
    return Keypair.fromSecretKey(bytes).publicKey.toBase58();
  } catch {
    return null;
  }
}

/**
 * Open a URL in the default browser. Returns a Promise so the CLI process
 * stays alive until the OS launcher has actually been spawned. On Windows,
 * `cmd /c start` is spawned detached — `child_process.exec("start ...")`
 * is easy to lose when the parent exits (Commander `parse()` does not wait
 * on async actions).
 */
function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    let child;

    try {
      if (platform === "win32") {
        child = spawn("cmd.exe", ["/c", "start", "", url], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
      } else if (platform === "darwin") {
        child = spawn("open", [url], { detached: true, stdio: "ignore" });
      } else {
        child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
      }
    } catch (err) {
      reject(err);
      return;
    }

    child.on("error", reject);
    child.unref();
    // start/open/xdg-open return immediately once the browser is handed the URL.
    resolve();
  });
}

interface DashboardOpts {
  ci?: boolean;
  json?: boolean;
  wallet?: boolean;
}

async function runDashboard(
  address: string | undefined,
  opts: DashboardOpts,
): Promise<void> {
  const baseUrl = getDashboardUrl().replace(/\/$/, "");
  const isJson = process.env.BAKE_JSON === "true";
  const isCi = process.env.BAKE_CI === "true" || opts.ci;

  let url: string;
  if (address) {
    url = opts.wallet
      ? `${baseUrl}/wallet/${address}`
      : `${baseUrl}/program/${address}`;
  } else if (opts.wallet) {
    const publicKey = resolveLocalPublicKey();
    if (!publicKey) {
      if (isJson) {
        console.log(JSON.stringify({ error: "No local wallet found" }));
      } else {
        logger.warn(
          "No local wallet found. Run `bake login` first, or pass an address:\n\n  " +
            chalk.cyan("bake dashboard <address> --wallet") +
            "\n",
        );
      }
      process.exitCode = 1;
      return;
    }
    url = `${baseUrl}/wallet/${publicKey}`;
  } else {
    url = `${baseUrl}/`;
  }

  if (isJson) {
    console.log(JSON.stringify({ url }));
    return;
  }

  if (isCi) {
    console.log(url);
    return;
  }

  // Always print before launching so the user sees feedback even if the
  // browser spawn fails.
  console.log(`Opening dashboard: ${url}`);

  try {
    await openInBrowser(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `Could not open browser automatically (${message}). Visit this URL instead:\n  ${chalk.bold(url)}`,
    );
  }
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
      opts: { ci?: boolean; json?: boolean; wallet?: boolean },
    ) => {
      if (opts.json) process.env.BAKE_JSON = "true";
      if (opts.ci) process.env.BAKE_CI = "true";
      await runDashboard(address, opts);
    },
  );
