import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { exec } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fail } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import {
  sanitizeAgentName,
  scaffoldAgentProject,
} from "../lib/agentScaffold.js";

// ---------------------------------------------------------------------------
// Mode helpers (same pattern as init.ts)
// ---------------------------------------------------------------------------

function isJsonMode(): boolean {
  return process.env.BAKE_JSON === "true";
}

function isCiMode(): boolean {
  return process.env.BAKE_CI === "true";
}

type StepHandle = {
  succeed: (text?: string) => void;
  fail: (text?: string) => void;
};

function startStep(text: string): StepHandle {
  if (isJsonMode()) {
    return { succeed() {}, fail() {} };
  }
  if (isCiMode()) {
    logger.info(text);
    return {
      succeed: (msg) => logger.success(msg ?? `✓ ${text}`),
      fail: (msg) => logger.error(msg ?? `✗ ${text}`),
    };
  }
  const spinner = ora(text).start();
  return {
    succeed: (msg) => spinner.succeed(msg ?? text),
    fail: (msg) => spinner.fail(msg ?? text),
  };
}

// ---------------------------------------------------------------------------
// Init subcommand runner
// ---------------------------------------------------------------------------

interface AgentInitJson {
  name: string;
  path: string;
  files: string[];
}

async function runAgentInit(
  projectNameArg: string | undefined,
  opts: {
    force: boolean;
    yes: boolean;
    withCookieMcp: boolean;
  },
): Promise<void> {
  const cwd = process.cwd();
  const rawName = projectNameArg ?? "bake-agent";
  const name = sanitizeAgentName(rawName);
  const nameChanged = name !== rawName;

  if (nameChanged && !isJsonMode()) {
    logger.warn(
      `Project name sanitized to "${name}" (kebab-case, lowercase letters and digits only).`,
    );
  }

  const projectPath = resolve(cwd, name);

  const step = startStep(`Scaffolding agent project (${name})`);
  try {
    const result = scaffoldAgentProject({
      projectPath,
      projectName: name,
      includeCookieMcp: opts.withCookieMcp,
      force: opts.force,
    });
    step.succeed(`Created ${result.files.length} files in ${projectPath}`);

    // --- JSON output ---
    if (isJsonMode()) {
      const json: AgentInitJson = { name, path: projectPath, files: result.files };
      console.log(JSON.stringify(json, null, 2));
      return;
    }

    // --- Human / CI output ---
    console.log();
    if (isCiMode()) {
      console.log(`Scaffolded agent project at ${projectPath}`);
      console.log(`Files: ${result.files.join(", ")}`);
    } else {
      console.log(
        chalk.green(
          `✔ Scaffolded agent project at ${chalk.bold(projectPath)}`,
        ),
      );
      console.log();
      for (const f of result.files) {
        console.log(`  ${chalk.dim("create")} ${f}`);
      }
    }

    console.log();
    if (isCiMode()) {
      console.log(`Next: cd ${name}`);
    } else {
      console.log(chalk.dim(`Next: cd ${name}`));
      console.log(
        chalk.dim(
          `     Then paste mcp/mcp.json into your editor (see mcp/README.md)`,
        ),
      );
    }

    // --- Optional: install Cookie Chain agent skill (interactive only) ---
    if (process.stdout.isTTY === true && !isCiMode() && !isJsonMode() && !opts.yes) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      const answer = await new Promise<string>((resolve) => {
        rl.question(
          chalk.bold(
            "\nAlso install the Cookie Chain agent skill for Claude/Cursor? [Y/n] ",
          ) +
            chalk.dim(
              "\n  Teaches your AI coding agent Cookie Chain facts — writes only to ~/.claude/skills or ~/.cursor/skills, not this project.",
            ) +
            "\n  ",
          (a) => {
            rl.close();
            resolve(a);
          },
        );
      });

      if (answer.trim() === "" || answer.trim().toLowerCase() === "y") {
        const skillStep = startStep("Installing Cookie Chain agent skill");
        try {
          const result = await new Promise<{
            stdout: string;
            stderr: string;
          }>((resolve, reject) => {
            exec(
              "npx @cookiechain/skill install",
              { timeout: 60_000 },
              (error, stdout, stderr) => {
                if (error) reject(error);
                else resolve({ stdout, stderr });
              },
            );
          });
          const output = (result.stdout + result.stderr).trim();
          skillStep.succeed(
            output || "Cookie Chain agent skill installed",
          );
          if (output) {
            console.log(chalk.dim(`  ${output.replace(/\n/g, "\n  ")}`));
          }
        } catch (err) {
          skillStep.fail("Skill install failed (agent scaffold unaffected)");
          const msg = err instanceof Error ? err.message : String(err);
          console.log(chalk.dim(`  ${msg}`));
        }
      }
    }

    console.log();
  } catch (err) {
    step.fail("Scaffold failed");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

const agentInitCommand = new Command("init")
  .description("Scaffold a minimal AI-agent project pre-wired for bake MCP")
  .argument("[name]", "project directory name (default: bake-agent)")
  .option("--force", "overwrite if directory exists", false)
  .option("-y, --yes", "skip interactive prompts", false)
  .option("--with-cookie-mcp", "include cookie-mcp in MCP config (default: true)", true)
  .option("--no-cookie-mcp", "exclude cookie-mcp from MCP config")
  .action(
    async (
      name: string | undefined,
      opts: {
        force: boolean;
        yes: boolean;
        cookieMcp: boolean; // Commander camelCases --with-cookie-mcp / --no-cookie-mcp
      },
    ) => {
      await runAgentInit(name, {
        force: opts.force,
        yes: opts.yes,
        withCookieMcp: opts.cookieMcp,
      });
    },
  );

export const agentCommand = new Command("agent")
  .description("Agent-related commands (scaffold, configure)")
  .addCommand(agentInitCommand);
