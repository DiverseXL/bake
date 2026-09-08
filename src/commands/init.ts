import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { getCluster } from "../clusters/index.js";
import { readGlobalConfig } from "../config/index.js";
import { fail } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { runToolchainCommand } from "../lib/toolchain.js";
import { resolveWalletPath } from "../lib/wallet.js";

// ---------------------------------------------------------------------------
// Mode helpers
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
// Name sanitization (valid Rust crate / Anchor workspace identifier)
// ---------------------------------------------------------------------------

const RUST_RESERVED = new Set([
  "as",
  "async",
  "await",
  "break",
  "const",
  "continue",
  "crate",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  "abstract",
  "become",
  "box",
  "do",
  "final",
  "macro",
  "override",
  "priv",
  "typeof",
  "unsized",
  "virtual",
  "yield",
  "try",
]);

/** Lowercase + underscores, no leading digit -- valid Rust crate name. */
function sanitizeRustCrateName(raw: string): string {
  let name = raw.trim().toLowerCase();
  name = name.replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_");
  name = name.replace(/^_+|_+$/g, "");
  if (!name) name = "bake_project";
  if (/^[0-9]/.test(name)) name = `project_${name}`;
  if (RUST_RESERVED.has(name)) name = `${name}_program`;
  return name;
}

// ---------------------------------------------------------------------------
// Scaffold helpers
// ---------------------------------------------------------------------------

function flattenScaffold(projectPath: string, scaffoldDirName: string): void {
  const scaffoldPath = join(projectPath, scaffoldDirName);
  if (!existsSync(scaffoldPath)) {
    fail(
      `anchor init did not create expected directory: ${scaffoldPath}`,
    );
  }

  for (const entry of readdirSync(scaffoldPath)) {
    const from = join(scaffoldPath, entry);
    const to = join(projectPath, entry);
    if (existsSync(to)) {
      fail(
        `Cannot finish scaffolding: ${entry} already exists in ${projectPath}.`,
      );
    }
    renameSync(from, to);
  }

  rmSync(scaffoldPath, { recursive: true, force: true });
}

function overlayAnchorToml(toml: string, cookieRpcUrl: string): string {
  const bakeNoteLines = [
    `# bake: provider.cluster targets Cookie Chain by default (not localnet).`,
    `# For local anchor test, temporarily set cluster = "localnet" so the`,
    `# test validator is used -- [programs.localnet] stays configured for that.`,
  ];

  const lines = toml.split(/\r?\n/);
  let providerIdx = lines.findIndex((line) => line.trim() === "[provider]");
  if (providerIdx === -1) {
    return [
      toml.trimEnd(),
      "",
      ...bakeNoteLines,
      "",
      "[provider]",
      `cluster = "${cookieRpcUrl}"`,
      `wallet = "~/.config/solana/id.json"`,
      "",
    ].join("\n");
  }

  // Insert bake note once, immediately above the real [provider] table.
  if (!toml.includes("bake: provider.cluster targets Cookie Chain")) {
    lines.splice(providerIdx, 0, ...bakeNoteLines, "");
    providerIdx = lines.findIndex((line) => line.trim() === "[provider]");
  }

  let clusterLine = -1;
  for (let i = providerIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("[")) break; // next table
    if (/^cluster\s*=/.test(trimmed)) {
      clusterLine = i;
      break;
    }
  }

  if (clusterLine >= 0) {
    lines[clusterLine] = `cluster = "${cookieRpcUrl}"`;
  } else {
    lines.splice(providerIdx + 1, 0, `cluster = "${cookieRpcUrl}"`);
  }

  return lines.join("\n");
}

function writeBakeConfig(projectPath: string, programName: string): void {
  const config = {
    programName,
    cluster: "cookie",
    programs: [`programs/${programName}`],
  };
  writeFileSync(
    join(projectPath, "bake.config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf-8",
  );
}

function bakeQuickstartSection(programName: string): string {
  return [
    ``,
    `## Bake quickstart (Cookie Chain)`,
    ``,
    `This project was scaffolded with \`bake init\` and is pre-wired for Cookie Chain.`,
    ``,
    `1. \`bake login\` -- create or link a local keypair (once per machine)`,
    `2. \`bake use cookie\` -- point bake at Cookie Chain mainnet RPC`,
    `3. \`cd\` into this project (if you aren't already here)`,
    `4. \`bake deploy\` -- build, deploy, and register the deploy on-chain`,
    `5. \`bake logs\` / \`bake stats\` -- inspect activity after deploy`,
    ``,
    `Program name: \`${programName}\``,
    ``,
    `Local Anchor tests still work: set \`[provider] cluster = "localnet"\` in`,
    `\`Anchor.toml\` (or override for that session), then run \`anchor test\`.`,
    ``,
  ].join("\n");
}

function writeOrAppendReadme(projectPath: string, programName: string): void {
  const readmePath = join(projectPath, "README.md");
  const section = bakeQuickstartSection(programName);

  if (existsSync(readmePath)) {
    const existing = readFileSync(readmePath, "utf-8");
    if (existing.includes("## Bake quickstart (Cookie Chain)")) {
      return;
    }
    writeFileSync(readmePath, `${existing.trimEnd()}\n${section}`, "utf-8");
    return;
  }

  const body = [
    `# ${programName}`,
    ``,
    `Anchor workspace scaffolded by [bake](https://github.com/DiverseXL/bake) for Cookie Chain.`,
    section,
  ].join("\n");
  writeFileSync(readmePath, body, "utf-8");
}

function hasExplicitClusterConfigured(): boolean {
  const cfg = readGlobalConfig();
  return cfg?.activeCluster != null;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

interface InitJson {
  projectPath: string;
  programName: string;
  clusterConfigured: string;
  walletConfigured: boolean;
}

async function runInit(projectNameArg?: string): Promise<void> {
  const cookie = getCluster("cookie");
  const cwd = process.cwd();

  let projectPath: string;
  let rawName: string;

  if (projectNameArg !== undefined && projectNameArg.length > 0) {
    rawName = projectNameArg;
    projectPath = resolve(cwd, projectNameArg);
  } else {
    projectPath = cwd;
    rawName = basename(cwd);
  }

  const programName = sanitizeRustCrateName(rawName);
  const nameChanged = programName !== rawName;

  if (existsSync(join(projectPath, "Anchor.toml"))) {
    fail("Anchor project already exists here — nothing to initialize.");
  }

  // Avoid nesting into an existing same-named folder left behind.
  if (existsSync(join(projectPath, programName, "Anchor.toml"))) {
    fail("Anchor project already exists here — nothing to initialize.");
  }

  if (projectNameArg !== undefined && projectNameArg.length > 0) {
    if (!existsSync(projectPath)) {
      mkdirSync(projectPath, { recursive: true });
    }
  }

  if (nameChanged && !isJsonMode()) {
    logger.warn(
      `Program name sanitized to "${programName}" (valid Rust crate names are lowercase with underscores).`,
    );
  }

  const scaffold = startStep(`Running anchor init ${programName}`);
  const initResult = await runToolchainCommand(
    "anchor",
    ["init", programName, "--no-install"],
    { cwd: projectPath },
  );
  if (initResult.exitCode !== 0) {
    scaffold.fail("anchor init failed");
    const detail = (initResult.stderr || initResult.stdout).trim();
    fail(detail ? `anchor init failed:\n${detail}` : "anchor init failed.");
  }
  scaffold.succeed(`Scaffolded Anchor workspace (${programName})`);

  const flatten = startStep("Placing project files");
  try {
    flattenScaffold(projectPath, programName);
    flatten.succeed("Project files ready");
  } catch (err) {
    flatten.fail("Failed to place project files");
    throw err;
  }

  const overlay = startStep("Applying Cookie Chain bake defaults");
  try {
    const anchorTomlPath = join(projectPath, "Anchor.toml");
    const toml = readFileSync(anchorTomlPath, "utf-8");
    writeFileSync(anchorTomlPath, overlayAnchorToml(toml, cookie.endpoint), "utf-8");
    writeBakeConfig(projectPath, programName);
    writeOrAppendReadme(projectPath, programName);
    overlay.succeed("Cookie Chain config + bake.config.json + README quickstart");
  } catch (err) {
    overlay.fail("Failed to apply bake defaults");
    throw err;
  }

  const walletConfigured = resolveWalletPath() != null;
  const clusterConfigured = cookie.name;
  const explicitCluster = hasExplicitClusterConfigured();

  const result: InitJson = {
    projectPath,
    programName,
    clusterConfigured,
    walletConfigured,
  };

  if (isJsonMode()) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log();
  if (isCiMode()) {
    console.log(`Initialized bake project at ${projectPath}`);
    console.log(`Program name: ${programName}`);
    console.log(`Provider cluster: Cookie Chain (${cookie.endpoint})`);
  } else {
    console.log(
      chalk.green(`✔ Initialized bake project at ${chalk.bold(projectPath)}`),
    );
    console.log(`  Program:  ${chalk.bold(programName)}`);
    console.log(
      `  Cluster:  ${chalk.bold("cookie")} (${chalk.dim(cookie.endpoint)})`,
    );
  }

  if (!walletConfigured) {
    console.log();
    if (isCiMode()) {
      console.log("No wallet configured yet — run `bake login` to get started.");
    } else {
      console.log(
        chalk.yellow(
          "No wallet configured yet — run `bake login` to get started.",
        ),
      );
    }
  } else if (!explicitCluster) {
    console.log();
    if (isCiMode()) {
      console.log(
        "Tip: run `bake use cookie` to pin Cookie Chain as your active cluster.",
      );
    } else {
      console.log(
        chalk.dim(
          "Tip: run `bake use cookie` to pin Cookie Chain as your active cluster.",
        ),
      );
    }
  }

  if (
    projectNameArg !== undefined &&
    projectNameArg.length > 0 &&
    resolve(cwd) !== projectPath
  ) {
    console.log();
    console.log(
      isCiMode()
        ? `Next: cd ${projectNameArg}`
        : chalk.dim(`Next: cd ${projectNameArg}`),
    );
  }

  console.log();
}

export const initCommand = new Command("init")
  .description(
    "Scaffold a new Anchor project pre-wired for Cookie Chain (bake.config.json + provider)",
  )
  .argument(
    "[projectName]",
    "new directory name (default: sanitize current directory name as the program)",
  )
  .option("--json", "output results as JSON")
  .option("--ci", "disable spinners/colors, force JSON-safe output")
  .action(async (projectName: string | undefined, opts) => {
    if (opts.json) process.env.BAKE_JSON = "true";
    if (opts.ci) process.env.BAKE_CI = "true";
    await runInit(projectName);
  });
