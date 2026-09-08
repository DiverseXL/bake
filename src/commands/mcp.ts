import { Command } from "commander";
import { loadMcpPolicy } from "../lib/mcpPolicy.js";
import { startBakeMcpServer } from "../lib/mcpServer.js";
import { fail } from "../lib/errors.js";

export const mcpCommand = new Command("mcp")
  .description(
    "Start the bake MCP server (stdio) for AI agents — read-only by default",
  )
  .option(
    "--policy <path>",
    "Path to MCP policy JSON (default: .bake/mcp-policy.json if present)",
  )
  .option("--json", "ignored for mcp (protocol uses stdout); accepted for flag parity")
  .option("--ci", "disable colors in any incidental stderr text")
  .action(async (opts: { policy?: string; json?: boolean; ci?: boolean }) => {
    if (opts.ci) process.env.BAKE_CI = "true";
    // Never print the ASCII banner on the MCP stdio channel.
    process.env.BAKE_CI = "true";

    try {
      const loaded = loadMcpPolicy(process.cwd(), opts.policy);
      await startBakeMcpServer(loaded, process.cwd());
      // Stdio server runs until stdin closes; keep the process alive.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail(msg);
    }
  });
