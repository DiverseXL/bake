#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { loadConfigs } from "./config/index.js";
import { printBanner } from "./lib/banner.js";
import { VERSION } from "./lib/version.js";

// Suppress the benign "bigint: Failed to load bindings" warning from
// bigint-buffer (a transitive dependency via @solana/web3.js). The native
// C++ addon fails to load on most environments; bigint-buffer falls back to
// a pure-JS implementation automatically — this is the SAFER path, since
// the native addon has a known buffer overflow vulnerability
// (GHSA-3gc7-fjrx-p6mg, fixed only in >=2.0.0 which web3.js v1 doesn't
// use). See AGENTS.md §11.1 for the full audit triage.
// The message fires at require() time (module body), so we must patch
// console.warn before any import that transitively pulls in @solana/web3.js.
const _origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (
    typeof args[0] === "string" &&
    args[0].includes("Failed to load bindings")
  )
    return;
  _origWarn(...args);
};

// Dynamic import of command modules (which transitively load @solana/web3.js
// and trigger bigint-buffer) so the console.warn patch above runs first.
const {
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
  auditCommand,
  mcpCommand,
  whoamiCommand,
  doctorCommand,
  dashboardCommand,
  agentCommand,
} = await import("./commands/index.js");

// Restore original console.warn so bake's own output is unaffected.
console.warn = _origWarn;

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
program.addCommand(auditCommand);
program.addCommand(mcpCommand);
program.addCommand(whoamiCommand);
program.addCommand(doctorCommand);
program.addCommand(dashboardCommand);
program.addCommand(agentCommand);

program.action(async () => {
  await loadGlobalConfig();
  // If no subcommand was matched, commander prints help automatically.
});

// Before any command logic. printBanner() no-ops on --ci/--json and non-TTY.
printBanner();
// parseAsync keeps the process alive until async command actions finish
// (browser spawn, etc.). parse() returns immediately and can exit first.
program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`\nError: ${message}\n`));
  process.exit(1);
});
