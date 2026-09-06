import { Command } from "commander";
import chalk from "chalk";

export const proveCommand = new Command("prove").description(
  "Generate or verify program proofs"
).action(() => {
  console.log(chalk.yellow("⚠ 'bake prove' is not implemented yet"));
});
