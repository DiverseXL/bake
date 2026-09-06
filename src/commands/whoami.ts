import { Command } from "commander";
import chalk from "chalk";
import { readGlobalConfig } from "../config/index.js";
import { getActiveCluster } from "../lib/connection.js";
import { logger } from "../lib/logger.js";

interface WhoamiResult {
  localWallet: string | null;
  nightlyWallet: string | null;
  cluster: string;
  rpcUrl: string;
}

async function runWhoami(): Promise<void> {
  const isJson = process.env.BAKE_JSON === "true";
  const cfg = readGlobalConfig();
  const cluster = getActiveCluster();

  const localWallet = cfg?.walletPath ?? null;
  const nightlyWallet = cfg?.nightlyWallet?.publicKey ?? null;

  const result: WhoamiResult = {
    localWallet,
    nightlyWallet,
    cluster: cluster.name,
    rpcUrl: cluster.rpcUrl,
  };

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log();
  console.log(`  Cluster:     ${chalk.bold(cluster.name)} (${cluster.rpcUrl})`);
  if (localWallet) {
    console.log(`  Local key:   ${chalk.dim(localWallet)}`);
  } else {
    console.log(`  Local key:   ${chalk.yellow("not configured")}  (run ${chalk.cyan("bake login")} to set up)`);
  }
  if (nightlyWallet) {
    console.log(`  Nightly key: ${chalk.dim(nightlyWallet)}`);
  } else {
    console.log(`  Nightly key: ${chalk.dim("not connected")}`);
  }
  console.log();
}

export const whoamiCommand = new Command("whoami")
  .description("Show active wallet and cluster info")
  .action(async () => {
    await runWhoami();
  });
