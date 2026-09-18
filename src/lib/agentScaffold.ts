import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fail } from "./errors.js";

// ---------------------------------------------------------------------------
// Name sanitization (kebab-case for JS/Node agent projects)
// ---------------------------------------------------------------------------

export function sanitizeAgentName(raw: string): string {
  let name = raw.trim().toLowerCase();
  name = name.replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-");
  name = name.replace(/^-+|-+$/g, "");
  if (!name) name = "bake-agent";
  if (/^[0-9]/.test(name)) name = `agent-${name}`;
  return name;
}

// ---------------------------------------------------------------------------
// Scaffold file generators
// ---------------------------------------------------------------------------

export interface AgentScaffoldOptions {
  projectPath: string;
  projectName: string;
  includeCookieMcp: boolean;
  force?: boolean;
}

export interface AgentScaffoldResult {
  files: string[];
}

function writeFileEnsuringParent(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, content, "utf-8");
}

function policyExampleJson(): string {
  return (
    JSON.stringify(
      {
        allowWrites: false,
        allowedPrograms: "any",
        maxDeploysPerSession: 5,
        requireConfirmation: true,
      },
      null,
      2,
    ) + "\n"
  );
}

function packageJson(name: string): string {
  return (
    JSON.stringify(
      {
        name,
        private: true,
        description: `AI agent project scaffolded by bake — pre-wired for Cookie Chain via MCP`,
        scripts: {
          "mcp:bake": "bake mcp --policy ./policy.example.json",
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function gitignore(): string {
  return [
    "# Dependencies",
    "node_modules/",
    "",
    "# Environment / secrets",
    ".env",
    ".env.*",
    "",
    "# Keypairs — never commit these",
    "*.json",
    "!package.json",
    "!policy.example.json",
    "",
    "# Bake local policy copies",
    ".bake/",
    "",
    "# OS",
    ".DS_Store",
    "Thumbs.db",
    "",
  ].join("\n");
}

function mcpJson(includeCookieMcp: boolean): string {
  const servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {
    bake: {
      command: "bake",
      args: ["mcp", "--policy", "./policy.example.json"],
    },
  };

  if (includeCookieMcp) {
    servers["cookie-mcp"] = {
      command: "npx",
      args: ["-y", "cookie-mcp"],
    };
  }

  return JSON.stringify({ mcpServers: servers }, null, 2) + "\n";
}

function mcpReadme(includeCookieMcp: boolean): string {
  const cookieMcpSection = includeCookieMcp
    ? [
        "",
        "## cookie-mcp (optional)",
        "",
        "The `cookie-mcp` block provides read-only token/liquidity lookups (price, pools,",
        "launchpad status). It needs **Node >= 22** and makes no on-chain writes.",
        "",
        "If you only need bake tools, you can remove the `cookie-mcp` block entirely, or",
        "start bake with `--no-cookie-mcp` next time you re-scaffold.",
        "",
      ].join("\n")
    : "";

  return [
    "# MCP server configuration",
    "",
    "This folder contains the MCP server config that wires your AI editor to `bake mcp`.",
    "",
    "## Quick start",
    "",
    "1. Start your editor **from the agent project root** (the directory containing this file).",
    "2. Paste the contents of `mcp.json` into your editor's MCP config (see below).",
    "3. Ask your agent: `run bake_whoami` — it should return your active wallet and cluster.",
    "",
    "## Where to paste",
    "",
    "### Cursor",
    "",
    "Paste into one of:",
    "- **Project-scoped:** `.cursor/mcp.json` in this project root",
    "- **Global:** `~/.cursor/mcp.json`",
    "",
    "The format is the `mcpServers` object directly — Cursor reads it as-is.",
    "",
    "### Claude Desktop",
    "",
    "Paste the `mcpServers` value into the Claude Desktop config file:",
    "",
    "- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`",
    "- **Windows:** `%APPDATA%\\Claude\\claude_desktop_config.json`",
    "",
    "Example: if the config file already has `\"mcpServers\": { ... }`, merge the",
    "bake entries into the existing object. If it's empty, paste the whole thing.",
    "",
    "### Other editors",
    "",
    "Any MCP-compatible editor (Windsurf, Zed, etc.) that reads `mcpServers` JSON",
    "should work with the same format.",
    "",
    "## Policy",
    "",
    "The `--policy ./policy.example.json` flag points to the policy file in this",
    "**project root**. Make sure your editor starts `bake mcp` from this directory,",
    "or copy `policy.example.json` to `.bake/mcp-policy.json` in the directory where",
    "your editor runs bake (bake auto-discovers it there).",
    "",
    "`policy.example.json` has `allowWrites: false` — write tools (`bake_deploy`,",
    "`bake_rollback`) are **not registered at all** until you deliberately set",
    "`allowWrites: true` in a policy file.",
    "",
    cookieMcpSection,
    "---",
    "",
    "See [bake on GitHub](https://github.com/DiverseXL/bake) for full documentation.",
  ].join("\n");
}

function promptsSystemMd(): string {
  return [
    "# Agent system prompt — bake MCP tools",
    "",
    "You are an AI agent with access to bake, a developer tool for Cookie Chain",
    "(an SVM/Solana-compatible blockchain). You communicate via MCP tools.",
    "",
    "## Read-only tools (always available)",
    "",
    "- `bake_whoami` — show active wallet(s) and cluster",
    "- `bake_stats` — program activity (invocations, error rate, unique signers, CU)",
    "- `bake_prove` — Level 1 on-chain hash check (verify bytecode matches Recipe Book entry)",
    "- `bake_logs` — recent program log history",
    "- `bake_get_history` — Recipe Book deploy entries for a program",
    "- `bake_check_token_liquidity` — token price/pool lookups via cookie-mcp",
    "",
    "## Write tools (only if policy allows)",
    "",
    "- `bake_deploy` — build, deploy, hash, and register on-chain",
    "- `bake_rollback` — rebuild and redeploy a previous Recipe Book entry",
    "- `bake_confirm_action` — execute a previously previewed write using a confirmation token",
    "",
    "Write tools follow a confirmation-token flow: the first call returns a preview",
    "and a token; the second call with that token executes. This is a safety net.",
    "",
    "## Rules",
    "",
    "1. **Prefer read-only tools first.** Before suggesting any write, check the state",
    "   with read-only tools.",
    "2. **Never ask the user to paste private keys, seeds, or wallet files into chat.**",
    "   Wallets are loaded from disk by bake — never transcribe secrets.",
    "3. **Write tools may not exist.** If the agent policy has `allowWrites: false`",
    "   (the default), deploy/rollback tools are not registered. Do not attempt to call them.",
    "4. **Cookie Chain is the primary cluster.** Default RPC: `https://rpc.cookiescan.io`.",
    "   Use `bake_whoami` to confirm the active cluster.",
    "5. **Recipe Book is on-chain history.** Every deploy is permanently recorded.",
    "   Do not invent explorer APIs or endpoints — use the on-chain data directly.",
    "6. **Do not fabricate tool results.** If a tool call fails or returns an error,",
    "   report it honestly. Do not generate plausible-looking fake data.",
  ].join("\n");
}

function readmeMd(name: string, includeCookieMcp: boolean): string {
  const cookieMcpNote = includeCookieMcp
    ? [
        "",
        "This project also includes `cookie-mcp` for read-only token/liquidity lookups.",
        "It is optional — remove the `cookie-mcp` block from `mcp/mcp.json` if you",
        "only need bake tools. cookie-mcp requires Node >= 22.",
      ].join("\n")
    : "";

  return [
    `# ${name}`,
    "",
    "AI agent project scaffolded by [bake](https://github.com/DiverseXL/bake).",
    "Pre-wired to talk to `bake mcp` over MCP stdio — no on-chain transactions",
    "until you explicitly enable write access.",
    "",
    "## Prerequisites",
    "",
    "- **Node.js >= 22**",
    "- **bake CLI:** `npm install -g bakeacookie`",
    "- **Cookie Chain toolchain** (Rust, Solana CLI, Anchor) — only if you plan to deploy",
    "",
    "## Quick start",
    "",
    "```bash",
    "# 1. Install bake (if you haven't already)",
    "npm install -g bakeacookie",
    "",
    "# 2. Verify bake is working",
    "bake --help",
    "",
    "# 3. Point your editor at the MCP config (see mcp/README.md for exact steps)",
    "",
    "# 4. Ask your agent a read-only question:",
    "#    \"run bake_whoami\"",
    "#    \"what cluster am I on?\"",
    "```",
    "",
    "## Project structure",
    "",
    "```",
    `${name}/`,
    "├── README.md                # this file",
    "├── package.json             # minimal metadata",
    "├── policy.example.json      # bake MCP policy (read-only by default)",
    "├── prompts/",
    "│   └── system.md            # agent instructions for bake tools",
    "└── mcp/",
    "    ├── mcp.json             # MCP server config (paste into your editor)",
    "    └── README.md            # where to paste for Cursor / Claude Desktop",
    "```",
    "",
    "## Enabling writes (deploy, rollback)",
    "",
    "> **Warning:** Enabling writes allows the agent to deploy programs on-chain.",
    "> Only do this if you understand the implications.",
    "",
    "1. Copy `policy.example.json` to `.bake/mcp-policy.json` in this directory.",
    "2. Set `\"allowWrites\": true` in the copied file.",
    "3. Restart your editor's MCP server.",
    "",
    "Write tools will then be registered. Deploy/rollback still require a",
    "confirmation token (human-in-the-loop) unless you also set",
    "`\"requireConfirmation\": false`.",
    "",
    "## Policy reference",
    "",
    "| Field | Default | Description |",
    "|---|---|---|",
    "| `allowWrites` | `false` | Register deploy/rollback tools |",
    "| `allowedPrograms` | `\"any\"` | Restrict deploys to specific program IDs |",
    "| `maxDeploysPerSession` | `5` | Cap on writes per MCP server lifetime |",
    "| `requireConfirmation` | `true` | Require confirmation token for writes |",
    "",
    cookieMcpNote,
    "## Links",
    "",
    "- [bake GitHub](https://github.com/DiverseXL/bake)",
    "- [bake dashboard](https://bakeacookie.vercel.app)",
    "- [Cookie Chain](https://www.cookiechain.wtf)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main scaffold function
// ---------------------------------------------------------------------------

export function scaffoldAgentProject(opts: AgentScaffoldOptions): AgentScaffoldResult {
  const { projectPath, projectName, includeCookieMcp } = opts;

  if (existsSync(projectPath)) {
    const entries = readdirSync(projectPath);
    if (entries.length > 0 && !opts.force) {
      fail(
        `Directory already exists and is non-empty: ${projectPath}\nUse --force to overwrite, or choose a different name.`,
      );
    }
    // Empty directory (or --force) is fine — proceed
  } else {
    mkdirSync(projectPath, { recursive: true });
  }

  const files: string[] = [];

  const write = (relativePath: string, content: string) => {
    const abs = join(projectPath, relativePath);
    writeFileEnsuringParent(abs, content);
    files.push(relativePath);
  };

  write("policy.example.json", policyExampleJson());
  write("package.json", packageJson(projectName));
  write(".gitignore", gitignore());
  write("prompts/system.md", promptsSystemMd());
  write("mcp/mcp.json", mcpJson(includeCookieMcp));
  write("mcp/README.md", mcpReadme(includeCookieMcp));
  write("README.md", readmeMd(projectName, includeCookieMcp));

  return { files };
}
