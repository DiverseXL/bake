import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../lib/logger.js";
import { fail } from "../lib/errors.js";
import {
  openSession,
  startSessionValidator,
  getActiveSession,
  closeSession,
  buildSessionDeployEnv,
  type SessionMeta,
} from "../lib/session.js";

// ---------------------------------------------------------------------------
// Mode helpers (same pattern as init.ts / agent.ts)
// ---------------------------------------------------------------------------

function isJsonMode(): boolean {
  return process.env.BAKE_JSON === "true";
}

function isCiMode(): boolean {
  return process.env.BAKE_CI === "true";
}

// ---------------------------------------------------------------------------
// `session open`
// ---------------------------------------------------------------------------

async function runSessionOpen(opts: {
  port: number;
  noValidator: boolean;
  workspace: string;
  force: boolean;
  yes: boolean;
}): Promise<void> {
  // Handle --force: close existing session first
  if (opts.force) {
    const existing = getActiveSession();
    if (existing) {
      if (!isJsonMode()) {
        logger.warn(`Closing existing session ${existing.id} (--force)...`);
      }
      closeSession(existing);
    }
  }

  let result: ReturnType<typeof openSession>;
  try {
    result = openSession({
      port: opts.port,
      noValidator: opts.noValidator,
      workspaceDir: opts.workspace,
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const meta = result.meta;

  // Start validator (unless --no-validator)
  if (!opts.noValidator) {
    if (!isJsonMode()) {
      logger.info(`Starting local validator on port ${meta.rpcPort}...`);
    }
    try {
      await startSessionValidator(meta);
    } catch (err) {
      // Clean up session on validator failure
      closeSession(meta);
      fail(
        `Failed to start validator: ${err instanceof Error ? err.message : String(err)}\n` +
        `Session has been cleaned up. Try --port <other> if port ${meta.rpcPort} is in use.`,
      );
    }
  }

  // Airdrop SOL to ephemeral keypair on local validator (best-effort)
  if (!opts.noValidator) {
    try {
      const { runToolchainCommand } = await import("../lib/toolchain.js");
      const airdropResult = await runToolchainCommand(
        "solana",
        ["airdrop", "5", meta.publicKey, "--url", meta.rpcUrl],
        { cwd: process.cwd() },
      );
      if (airdropResult.exitCode === 0 && !isJsonMode()) {
        logger.success("Airdropped 5 SOL to ephemeral keypair");
      }
    } catch {
      // Airdrop failure is non-fatal
      if (!isJsonMode()) {
        logger.warn("Could not airdrop SOL — deploy may fail if the keypair has no balance");
      }
    }
  }

  // Output
  if (isJsonMode()) {
    console.log(JSON.stringify({
      id: meta.id,
      publicKey: meta.publicKey,
      rpcUrl: meta.rpcUrl,
      rpcPort: meta.rpcPort,
      workspaceDir: meta.workspaceDir,
      validatorRunning: meta.validatorRunning,
      validatorPid: meta.validatorPid,
    }, null, 2));
    return;
  }

  console.log();
  if (isCiMode()) {
    console.log(`Session opened: ${meta.id}`);
    console.log(`  Public key: ${meta.publicKey}`);
    console.log(`  RPC: ${meta.rpcUrl}`);
    console.log(`  Workspace: ${meta.workspaceDir}`);
    console.log(`  Validator: ${meta.validatorRunning ? `running (PID ${meta.validatorPid})` : "not started"}`);
  } else {
    console.log(chalk.green(`✔ Session opened: ${chalk.bold(meta.id)}`));
    console.log();
    console.log(`  Public key:  ${chalk.cyan(meta.publicKey)}`);
    console.log(`  RPC:         ${chalk.cyan(meta.rpcUrl)}`);
    console.log(`  Workspace:   ${meta.workspaceDir}`);
    console.log(`  Validator:   ${meta.validatorRunning ? chalk.green(`running (PID ${meta.validatorPid})`) : chalk.yellow("not started")}`);
    console.log();
    console.log(chalk.dim("  Next steps:"));
    console.log(chalk.dim(`    cd ${meta.workspaceDir}`));
    console.log(chalk.dim("    bake session deploy"));
    console.log(chalk.dim("    bake session close"));
    console.log();
  }
}

// ---------------------------------------------------------------------------
// `session status`
// ---------------------------------------------------------------------------

function runSessionStatus(): void {
  const meta = getActiveSession();

  if (!meta) {
    if (isJsonMode()) {
      console.log(JSON.stringify({ active: false }));
    } else {
      console.log(isCiMode()
        ? "No active session."
        : chalk.dim("No active session. Run `bake session open` to create one."));
    }
    return;
  }

  if (isJsonMode()) {
    console.log(JSON.stringify({
      active: true,
      id: meta.id,
      createdAt: meta.createdAt,
      publicKey: meta.publicKey,
      rpcUrl: meta.rpcUrl,
      rpcPort: meta.rpcPort,
      workspaceDir: meta.workspaceDir,
      validatorRunning: meta.validatorRunning,
      validatorPid: meta.validatorPid,
      clusterLabel: meta.clusterLabel,
    }, null, 2));
    return;
  }

  console.log();
  if (isCiMode()) {
    console.log(`Active session: ${meta.id}`);
    console.log(`  Created: ${meta.createdAt}`);
    console.log(`  Public key: ${meta.publicKey}`);
    console.log(`  RPC: ${meta.rpcUrl}`);
    console.log(`  Workspace: ${meta.workspaceDir}`);
    console.log(`  Validator: ${meta.validatorRunning ? `running (PID ${meta.validatorPid})` : "not running"}`);
  } else {
    console.log(chalk.bold("  Active session"));
    console.log(chalk.gray("  ────────────────────────────────────────"));
    console.log(`  ID:          ${chalk.bold(meta.id)}`);
    console.log(`  Created:     ${meta.createdAt}`);
    console.log(`  Public key:  ${chalk.cyan(meta.publicKey)}`);
    console.log(`  RPC:         ${chalk.cyan(meta.rpcUrl)}`);
    console.log(`  Workspace:   ${meta.workspaceDir}`);
    console.log(`  Validator:   ${meta.validatorRunning ? chalk.green(`running (PID ${meta.validatorPid})`) : chalk.yellow("not running")}`);
    console.log(chalk.gray("  ────────────────────────────────────────"));

    if (!meta.validatorRunning) {
      console.log();
      logger.warn(
        "Validator is not running. Run `bake session open` to restart, or `bake session close` to clean up.",
      );
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// `session deploy`
// ---------------------------------------------------------------------------

async function runSessionDeploy(opts: { yes: boolean }): Promise<void> {
  const meta = getActiveSession();
  if (!meta) {
    fail("No active session. Run `bake session open` first.");
  }

  const workspace = meta.workspaceDir;
  const tomlPath = join(workspace, "Anchor.toml");
  if (!existsSync(tomlPath)) {
    fail(
      `No Anchor.toml found in session workspace: ${workspace}\n` +
      `The session workspace must be (or contain) an Anchor project.`,
    );
  }

  // Confirmation (unless --yes/--ci/--json)
  if (!opts.yes && !isCiMode() && !isJsonMode() && process.stdout.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        chalk.bold(`Deploy from session workspace ${workspace}? [Y/n] `),
        (a) => { rl.close(); resolve(a); },
      );
    });
    if (answer.trim() !== "" && answer.trim().toLowerCase() !== "y") {
      logger.info("Deploy cancelled.");
      return;
    }
  }

  // Set up process-local env overrides (DO NOT touch global config)
  const { runDeployPipeline } = await import("../lib/deployPipeline.js");
  const { env, restore } = buildSessionDeployEnv(meta);

  // Apply session env vars to this process
  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    if (!isJsonMode()) {
      logger.info(`Deploying to session ${meta.id} (${meta.rpcUrl})...`);
    }

    const result = await runDeployPipeline(workspace);

    if (isJsonMode()) {
      console.log(JSON.stringify({
        sessionId: meta.id,
        programId: result.programId,
        deploySignature: result.deploySignature,
        entryIndex: result.entryIndex,
        rpcUrl: meta.rpcUrl,
        mock: result.mock,
      }, null, 2));
    } else {
      console.log();
      if (isCiMode()) {
        console.log(`Deployed to session ${meta.id}`);
        console.log(`  Program: ${result.programId}`);
        console.log(`  Signature: ${result.deploySignature}`);
      } else {
        console.log(chalk.green(`✔ Deployed to session ${chalk.bold(meta.id)}`));
        console.log(`  Program:     ${chalk.cyan(result.programId)}`);
        console.log(`  Signature:   ${result.deploySignature}`);
        console.log(`  RPC:         ${chalk.cyan(meta.rpcUrl)}`);
        if (result.mock) {
          console.log(chalk.yellow("  (Recipe Book is in mock mode — no on-chain registration)"));
        }
      }
      console.log();
    }
  } catch (err) {
    fail(
      `Session deploy failed: ${err instanceof Error ? err.message : String(err)}\n` +
      "The session is still active — fix the issue and retry, or `bake session close` to clean up.",
    );
  } finally {
    // Restore process env (DO NOT clobber user's global config)
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
    restore();
  }
}

// ---------------------------------------------------------------------------
// `session close`
// ---------------------------------------------------------------------------

async function runSessionClose(opts: { yes: boolean; keepWorkspace: boolean }): Promise<void> {
  const meta = getActiveSession();
  if (!meta) {
    if (isJsonMode()) {
      console.log(JSON.stringify({ closed: false, message: "No active session" }));
    } else {
      console.log(isCiMode()
        ? "No active session to close."
        : chalk.dim("No active session to close."));
    }
    return;
  }

  // Confirmation (unless --yes/--ci/--json)
  if (!opts.yes && !isCiMode() && !isJsonMode() && process.stdout.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        chalk.bold(`Close session ${meta.id}? This will stop the validator and delete ephemeral keys. [y/N] `),
        (a) => { rl.close(); resolve(a); },
      );
    });
    if (answer.trim().toLowerCase() !== "y") {
      logger.info("Close cancelled.");
      return;
    }
  }

  closeSession(meta, { keepWorkspace: opts.keepWorkspace });

  if (isJsonMode()) {
    console.log(JSON.stringify({ closed: true, id: meta.id }, null, 2));
    return;
  }

  console.log();
  if (isCiMode()) {
    console.log(`Session ${meta.id} closed.`);
  } else {
    console.log(chalk.green(`✔ Session ${chalk.bold(meta.id)} closed.`));
    if (meta.validatorRunning) {
      console.log(chalk.dim("  Validator stopped."));
    }
    console.log(chalk.dim("  Ephemeral keypair deleted."));
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

const sessionOpenCommand = new Command("open")
  .description("Create a new session with ephemeral keypair + optional local validator")
  .option("--port <number>", "Local validator port", "8899")
  .option("--no-validator", "Only create ephemeral keypair + metadata (no validator)")
  .option("--workspace <path>", "Project dir for later deploy (default: cwd)", process.cwd())
  .option("--force", "Replace existing active session", false)
  .option("-y, --yes", "Skip interactive prompts", false)
  .action(async (opts: {
    port: string;
    validator: boolean;
    workspace: string;
    force: boolean;
    yes: boolean;
  }) => {
    const port = parseInt(opts.port, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      fail("--port must be a valid port number (1-65535)");
    }
    await runSessionOpen({
      port,
      noValidator: !opts.validator,
      workspace: opts.workspace,
      force: opts.force,
      yes: opts.yes,
    });
  });

const sessionStatusCommand = new Command("status")
  .description("Show the active session (id, pubkey, rpc, validator status)")
  .action(() => {
    runSessionStatus();
  });

const sessionDeployCommand = new Command("deploy")
  .description("Deploy the current Anchor project into the active session")
  .option("-y, --yes", "Skip confirmation prompt", false)
  .action(async (opts: { yes: boolean }) => {
    await runSessionDeploy(opts);
  });

const sessionCloseCommand = new Command("close")
  .description("Tear down the active session (stop validator, delete ephemeral keys)")
  .option("-y, --yes", "Skip confirmation", false)
  .option("--keep-workspace", "Do not delete temp files outside ~/.bake/sessions", false)
  .action(async (opts: { yes: boolean; keepWorkspace: boolean }) => {
    await runSessionClose(opts);
  });

export const sessionCommand = new Command("session")
  .description("Disposable local deploy workspaces (open → deploy → close)")
  .addCommand(sessionOpenCommand)
  .addCommand(sessionStatusCommand)
  .addCommand(sessionDeployCommand)
  .addCommand(sessionCloseCommand);
