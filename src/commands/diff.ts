import { Command } from "commander";
import chalk from "chalk";

export const diffCommand = new Command("diff").description(
  "Show differences between local and deployed programs"
).action(() => {
  console.log(chalk.yellow("⚠ 'bake diff' is not implemented yet"));
});
