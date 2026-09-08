import { spawn } from "node:child_process";
import { BakeError } from "./errors.js";

const WSL_DISTRO = "Ubuntu";

export interface ToolchainResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type ToolchainOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ToolchainResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function windowsPathToWsl(winPath: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!match) {
    throw new BakeError(`Cannot convert Windows path to WSL path: ${winPath}`);
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

async function listWslDistros(): Promise<string[]> {
  let result: ToolchainResult;
  try {
    result = await runProcess("wsl", ["-l", "-q"]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    throw new BakeError(
      `Anchor/Solana tooling requires WSL on Windows. Run 'wsl --install' in an Admin PowerShell, reboot, then set up the toolchain inside Ubuntu (see README). (${message})`,
    );
  }
  if (result.exitCode !== 0) {
    throw new BakeError(
      "Anchor/Solana tooling requires WSL on Windows. Run 'wsl --install' in an Admin PowerShell, reboot, then set up the toolchain inside Ubuntu (see README).",
    );
  }
  return result.stdout
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function ensureWslToolchain(): Promise<void> {
  const distros = await listWslDistros();
  if (!distros.some((distro) => distro.toLowerCase() === WSL_DISTRO.toLowerCase())) {
    throw new BakeError(
      `WSL is installed, but the "${WSL_DISTRO}" distro was not found. Install it with "wsl --install -d ${WSL_DISTRO}", then set up the Anchor/Solana toolchain inside it.`,
    );
  }
}

export async function checkWslToolchain(): Promise<{
  ok: boolean;
  message: string;
}> {
  if (process.platform !== "win32") {
    return { ok: true, message: "Native toolchain execution is available." };
  }
  try {
    await ensureWslToolchain();
    return { ok: true, message: `WSL ${WSL_DISTRO} is available.` };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runToolchainCommand(
  command: string,
  args: string[],
  options: ToolchainOptions,
): Promise<ToolchainResult> {
  if (process.platform !== "win32") {
    return runProcess(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
  }

  await ensureWslToolchain();
  const wslPath = windowsPathToWsl(options.cwd);
  const envExports = Object.entries(options.env ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const text = value as string;
      const converted = /^[A-Za-z]:[\\/]/.test(text)
        ? windowsPathToWsl(text)
        : text;
      return `export ${key}=${shellQuote(converted)}`;
    })
    .join("; ");
  const commandLine = [command, ...args.map(shellQuote)].join(" ");
  const prelude = [
    'source "$HOME/.cargo/env" 2>/dev/null',
    'source "$HOME/.nvm/nvm.sh" 2>/dev/null',
    'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"',
    envExports,
  ]
    .filter(Boolean)
    .join("; ");
  const innerCommand = `${prelude}; cd ${shellQuote(wslPath)} && ${commandLine}`;

  console.error(`[relayed via WSL] Windows detected; running ${command} in ${WSL_DISTRO}.`);
  const result = await runProcess("wsl", [
    "-d",
    WSL_DISTRO,
    "-e",
    "bash",
    "-lc",
    innerCommand,
  ]);
  if (result.exitCode !== 0) {
    return {
      ...result,
      stderr: `[relayed via WSL]\n${result.stderr}`,
    };
  }
  return result;
}

export function runAnchorBuild(cwd: string): Promise<ToolchainResult> {
  // SBPF v3 artifacts are rejected by this project's solana-test-validator;
  // v0 is the compatible target discovered during toolchain debugging.
  // IDL generation is intentionally enabled: anchor-lang 1.2.0's idl-build
  // path now completes successfully and the generated IDL was live-validated.
  return runToolchainCommand(
    "anchor",
    ["build", "--arch", "v0", "--tools-version", "v1.57"],
    { cwd },
  );
}
