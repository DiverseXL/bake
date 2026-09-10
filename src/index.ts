#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { loadConfigs } from "./config/index.js";
import { printBanner } from "./lib/banner.js";
import {
  initCommand,
  loginCommand,
  useCommand,
  deployCommand,
  logsCommand,
  rollbackCommand,
  diffCommand,
  statsCommand,
  proveCommand,
  forkCommand,
  decodeCommand,
  topCommand,
  mcpCommand,
  whoamiCommand,
  doctorCommand,
} from "./commands/index.js";

const VERSION = "0.1.0";

// Global option values (set before subcommand actions run).
export let globalCi = false;
export let globalJson = false;

async function loadGlobalConfig() {
  try {
    const config = await loadConfigs();
    process.env.BAKE_CONFIG = JSON.stringify(config);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to load configuration";
    console.error(chalk.red(`\nError: ${message}\n`));
    process.exit(1);
  }
}

const program = new Command();

program
  .name("bake")
  .description(
    "Developer tool for Cookie Chain — an SVM/Solana-compatible blockchain"
  )
  .version(VERSION, "-v, --version", "output the version number")
  .option("--ci", "disable spinners/colors, force JSON-safe output", false)
  .option("--json", "output results as JSON", false)

// Propagate global --ci / --json flags to env vars so every subcommand can
// read them via process.env.BAKE_CI / BAKE_JSON.
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.opts();
  globalCi = opts.ci ?? false;
  globalJson = opts.json ?? false;
  process.env.BAKE_CI = String(globalCi);
  process.env.BAKE_JSON = String(globalJson);
});



// Register subcommands
program.addCommand(initCommand);
program.addCommand(loginCommand);
program.addCommand(useCommand);
program.addCommand(deployCommand);
program.addCommand(logsCommand);
program.addCommand(rollbackCommand);
program.addCommand(diffCommand);
program.addCommand(statsCommand);
program.addCommand(proveCommand);
program.addCommand(forkCommand);
program.addCommand(decodeCommand);
program.addCommand(topCommand);
program.addCommand(mcpCommand);
program.addCommand(whoamiCommand);
program.addCommand(doctorCommand);

program.action(async () => {
  await loadGlobalConfig();
  // If no subcommand was matched, commander prints help automatically.
});

// Before any command logic. printBanner() no-ops on --ci/--json and non-TTY.
printBanner();
program.parse(process.argv);
