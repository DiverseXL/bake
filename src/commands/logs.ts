import { Command } from "commander";
import chalk from "chalk";

export const logsCommand = new Command("logs").description(
  "View program logs on the active cluster"
).action(() => {
  console.log(chalk.yellow("⚠ 'bake logs' is not implemented yet"));
});
