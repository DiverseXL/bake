import { Command } from "commander";
import chalk from "chalk";

export const topCommand = new Command("top").description(
  "View network and program leaderboards or top accounts"
).action(() => {
  console.log(chalk.yellow("⚠ 'bake top' is not implemented yet"));
});
