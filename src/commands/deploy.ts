import { Command } from "commander";
import chalk from "chalk";

export const deployCommand = new Command("deploy").description(
  "Deploy an Anchor program to the active cluster"
).action(() => {
  console.log(chalk.yellow("⚠ 'bake deploy' is not implemented yet"));
});
