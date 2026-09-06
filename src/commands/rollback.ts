import { Command } from "commander";
import chalk from "chalk";

export const rollbackCommand = new Command("rollback").description(
  "Roll back to a previous program version"
).action(() => {
  console.log(chalk.yellow("⚠ 'bake rollback' is not implemented yet"));
});
