import { Command } from "commander";
import chalk from "chalk";

export const forkCommand = new Command("fork").description(
  "Fork a program or cluster state for local development"
).action(() => {
  console.log(chalk.yellow("⚠ 'bake fork' is not implemented yet"));
});
