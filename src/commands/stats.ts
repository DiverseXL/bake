import { Command } from "commander";
import chalk from "chalk";

export const statsCommand = new Command("stats").description(
  "Show program statistics and usage metrics"
).action(() => {
  console.log(chalk.yellow("⚠ 'bake stats' is not implemented yet"));
});
