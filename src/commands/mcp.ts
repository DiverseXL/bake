import { Command } from "commander";
import chalk from "chalk";

export const mcpCommand = new Command("mcp").description(
  "Interact with the bake MCP (model context protocol) server"
).action(() => {
  console.log(chalk.yellow("⚠ 'bake mcp' is not implemented yet"));
});
