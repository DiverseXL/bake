import { Command } from "commander";
import chalk from "chalk";

export const loginCommand = new Command("login").description(
  "Authenticate with your Cookie Chain wallet"
).action(() => {
  console.log(chalk.yellow("⚠ 'bake login' is not implemented yet"));
});
