import { Command } from "commander";
import chalk from "chalk";
import { exec } from "node:child_process";
import { logger } from "../lib/logger.js";

const DASHBOARD_DEFAULT_URL = "https://bakeacookie.vercel.app";

function getDashboardUrl(): string {
  return process.env.BAKE_DASHBOARD_URL || DASHBOARD_DEFAULT_URL;
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

  // Only /program/<address> exists on the live dashboard.
  // No arg → homepage; with address → program page.
  const url = address
    ? `${baseUrl}/program/${address}`
    : `${baseUrl}/`;

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
  .argument("[address]", "program address to view")
  .option("--ci", "print URL instead of opening browser")
  .option("--json", "output results as JSON")
  .action(
    async (
      address: string | undefined,
      opts: { ci?: boolean; json?: boolean },
    ) => {
      if (opts.json) process.env.BAKE_JSON = "true";
      if (opts.ci) process.env.BAKE_CI = "true";
      await runDashboard(address, opts);
    },
  );
