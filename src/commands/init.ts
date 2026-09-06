import { Command } from "commander";
import chalk from "chalk";

export const initCommand = new Command("init").description(
  "Initialize a new bake project in the current directory"
).action(() => {
  console.log(chalk.yellow("⚠ 'bake init' is not implemented yet"));
});
