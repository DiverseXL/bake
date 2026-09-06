import { Command } from "commander";
import chalk from "chalk";

export const decodeCommand = new Command("decode").description(
  "Decode transaction data or program instructions"
).action(() => {
  console.log(chalk.yellow("⚠ 'bake decode' is not implemented yet"));
});
