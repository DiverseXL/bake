import { Command } from "commander";
import chalk from "chalk";
import { spawnToolchainForeground } from "../lib/toolchain.js";
import { CLUSTERS, clusterExists } from "../clusters/index.js";
import { logger } from "../lib/logger.js";
import { fail } from "../lib/errors.js";

function isCiMode(): boolean {
  return process.env.BAKE_CI === "true";
}

function isJsonMode(): boolean {
  return process.env.BAKE_JSON === "true";
}

// ---------------------------------------------------------------------------
// Source RPC resolution
// ---------------------------------------------------------------------------

function resolveSourceRpc(source: string): { name: string; url: string } {
  // Direct URL passthrough
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return { name: source, url: source };
  }
  // Known preset
  if (clusterExists(source)) {
    const preset = CLUSTERS[source.toLowerCase()];
    return { name: preset.name, url: preset.endpoint };
  }
  const known = Object.keys(CLUSTERS).join(", ");
  fail(
    `Unknown source cluster "${source}". Known presets: ${known}, or pass a full RPC URL.`,
  );
}

// ---------------------------------------------------------------------------
// Pre-flight: validate the source RPC is reachable
// ---------------------------------------------------------------------------

async function validateSourceRpc(
  url: string,
  timeoutMs = 10_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getGenesisHash",
      }),
      signal: controller.signal,
    });
    const body = (await res.json()) as {
      result?: string;
      error?: { message?: string };
    };
    if (body.error) {
      fail(
        `Source RPC returned an error: ${body.error.message ?? JSON.stringify(body.error)}`,
      );
    }
    return body.result ?? "unknown";
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      fail(
        `Source RPC at ${url} timed out after ${timeoutMs / 1000}s. Check the URL or try a different provider.`,
      );
    }
    fail(
      `Cannot reach source RPC at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pre-flight: fetch program accounts (opt-in, error-tolerant)
// ---------------------------------------------------------------------------

interface FetchProgramAccountsResult {
  accounts: string[];
  warning?: string;
}

async function fetchProgramAccounts(
  sourceRpc: string,
  programId: string,
  limit: number,
): Promise<FetchProgramAccountsResult> {
  const controller = new AbortController();
  const timeoutMs = 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(sourceRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getProgramAccounts",
        params: [
          programId,
          {
            encoding: "base64",
            withContext: true,
            filters: [{ dataSize: 1 }],
          },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const body = (await res.json()) as {
      result?: { value: { pubkey: string }[] };
      error?: { message?: string; code?: number };
    };

    if (body.error) {
      const msg = body.error.message ?? JSON.stringify(body.error);
      // Common: RPC rejects getProgramAccounts on free endpoints
      if (
        body.error.code === -32600 ||
        msg.includes("disallow") ||
        msg.includes("rate") ||
        msg.includes("limit") ||
        msg.includes("Too many") ||
        msg.includes("exceeded")
      ) {
        return {
          accounts: [],
          warning:
            `getProgramAccounts was rejected by the source RPC (likely rate-limited or disabled on free endpoints).\n` +
            `   Tip: Use a paid RPC provider via --source <url>, or omit --fetch-program-accounts.`,
        };
      }
      return {
        accounts: [],
        warning: `getProgramAccounts returned an error: ${msg}`,
      };
    }

    const entries = body.result?.value ?? [];
    const pubkeys = entries
      .slice(0, limit)
      .map((e) => e.pubkey)
      .filter(Boolean);

    const total = entries.length;
    const warning =
      total > limit
        ? `Fetched ${limit} of ${total} accounts (capped by --limit ${limit}).`
        : undefined;

    return { accounts: pubkeys, warning };
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return {
        accounts: [],
        warning:
          `getProgramAccounts timed out after ${timeoutMs / 1000}s.\n` +
          `   The source RPC may be slow or rate-limited. Try a paid provider or omit --fetch-program-accounts.`,
      };
    }
    return {
      accounts: [],
      warning: `getProgramAccounts failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runFork(
  programId: string,
  opts: {
    source: string;
    accounts?: string;
    fetchProgramAccounts: boolean;
    limit: number;
    port: number;
    ci?: boolean;
    json?: boolean;
  },
): Promise<void> {
  if (opts.json) process.env.BAKE_JSON = "true";
  if (opts.ci) process.env.BAKE_CI = "true";

  // ── Resolve source ────────────────────────────────────────────────────
  const source = resolveSourceRpc(opts.source);

  if (!isJsonMode()) {
    logger.info(`Source cluster: ${source.name} (${source.url})`);
  }

  // ── Validate source RPC ───────────────────────────────────────────────
  if (!isJsonMode()) {
    logger.info("Validating source RPC...");
  }
  const genesisHash = await validateSourceRpc(source.url);
  if (!isJsonMode()) {
    logger.success(`Source RPC reachable (genesis: ${genesisHash.slice(0, 16)}...)`);
  }

  // ── Parse explicit extra accounts ─────────────────────────────────────
  const explicitAccounts: string[] = [];
  if (opts.accounts) {
    for (const acct of opts.accounts.split(",")) {
      const trimmed = acct.trim();
      if (trimmed) explicitAccounts.push(trimmed);
    }
  }

  // ── Optionally fetch program accounts ─────────────────────────────────
  let fetchedAccounts: string[] = [];
  let fetchWarning: string | undefined;
  if (opts.fetchProgramAccounts) {
    if (!isJsonMode()) {
      logger.info(
        `Fetching program accounts (limit: ${opts.limit})...`,
      );
    }
    const result = await fetchProgramAccounts(
      source.url,
      programId,
      opts.limit,
    );
    fetchedAccounts = result.accounts;
    fetchWarning = result.warning;
    if (fetchWarning && !isJsonMode()) {
      logger.warn(fetchWarning);
    }
    if (!isJsonMode() && fetchedAccounts.length > 0) {
      logger.success(`Fetched ${fetchedAccounts.length} program accounts`);
    }
  }

  // ── Build validator args ──────────────────────────────────────────────
  const totalAccounts = explicitAccounts.length + fetchedAccounts.length;
  const validatorArgs = [
    "solana-test-validator",
    "--clone-upgradeable-program",
    programId,
    "--url",
    source.url,
    "--reset",
    "--rpc-port",
    String(opts.port),
    "--faucet-sol",
    "0",
    "--ledger",
    "/tmp/bake-fork-ledger",
  ];
  for (const acct of [...explicitAccounts, ...fetchedAccounts]) {
    validatorArgs.push("--clone", acct);
  }

  // ── Summary ───────────────────────────────────────────────────────────
  if (isJsonMode()) {
    console.log(
      JSON.stringify({
        programId,
        source: source.name,
        sourceUrl: source.url,
        genesisHash,
        explicitAccounts: explicitAccounts.length,
        fetchedAccounts: fetchedAccounts.length,
        totalAccounts,
        port: opts.port,
      }),
    );
  } else {
    console.log("");
    console.log(chalk.bold("  bake fork"));
    console.log(chalk.gray("  ────────────────────────────────────────"));
    console.log(`  Program:         ${chalk.cyan(programId)}`);
    console.log(`  Source:          ${source.name} ${chalk.gray(`(${source.url})`)}`);
    console.log(`  Genesis:         ${chalk.gray(genesisHash.slice(0, 32) + "...")}`);
    console.log(`  Extra accounts:  ${explicitAccounts.length} explicit${fetchedAccounts.length > 0 ? ` + ${fetchedAccounts.length} fetched = ${totalAccounts} total` : totalAccounts > 0 ? "" : " (none)"}`);
    console.log(`  Port:            ${opts.port}`);
    console.log(chalk.gray("  ────────────────────────────────────────"));
    console.log("");
    console.log(
      `  Once running, point bake at it with:  ${chalk.bold.cyan(`bake use http://127.0.0.1:${opts.port}`)}`,
    );
    console.log("");
  }

  // ── Spawn validator (foreground, live streaming) ───────────────────────
  if (!isJsonMode()) {
    logger.info("Starting solana-test-validator (Ctrl+C to stop)...");
    console.log("");
  }

  const result = await spawnToolchainForeground(
    validatorArgs[0],
    validatorArgs.slice(1),
  );

  // ── Exit handling ─────────────────────────────────────────────────────
  // signal === "SIGINT" means user pressed Ctrl+C — clean shutdown, not an error.
  if (result.signal === "SIGINT" || result.signal === "SIGTERM") {
    if (!isJsonMode()) {
      console.log("");
      logger.info("Validator stopped.");
    }
    process.exit(0);
  }

  if (result.code !== 0 && result.code !== null) {
    // Non-zero exit without a signal = actual failure
    const output = `solana-test-validator exited with code ${result.code}`;
    if (isJsonMode()) {
      console.log(JSON.stringify({ error: output, exitCode: result.code }));
    } else {
      console.log("");
      logger.error(output);
      if (result.code === 13) {
        // Common: port already in use
        logger.warn(
          `Port ${opts.port} may already be in use. Try a different port with --port, or stop the existing validator.`,
        );
      }
    }
    process.exit(result.code);
  }

  // Clean exit (code 0, no signal) — validator was stopped externally
  if (!isJsonMode()) {
    console.log("");
    logger.info("Validator stopped.");
  }
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const forkCommand = new Command("fork")
  .description(
    "Clone a program (and optionally its accounts) from a source cluster into a fresh local validator",
  )
  .argument("<programId>", "Program ID to clone (base58)")
  .option(
    "--source <cluster>",
    "Source cluster preset (mainnet, devnet, cookie) or full RPC URL",
    "mainnet",
  )
  .option(
    "--accounts <pubkeys>",
    "Comma-separated extra accounts to clone (token mints, config accounts, etc.)",
  )
  .option(
    "--fetch-program-accounts",
    "Also clone accounts owned by the program (via getProgramAccounts). May be slow or rejected on public RPCs.",
    false,
  )
  .option(
    "--limit <n>",
    "Max accounts to fetch with --fetch-program-accounts",
    (val: string) => {
      const n = parseInt(val, 10);
      if (Number.isNaN(n) || n < 1) {
        fail("--limit must be a positive integer");
      }
      return n;
    },
    20,
  )
  .option("--port <port>", "Port for the local validator", "8899")
  .option("--ci", "Disable spinners/colors, force JSON-safe output", false)
  .option("--json", "Output results as JSON", false)
  .action(
    async (
      programId: string,
      opts: {
        source: string;
        accounts?: string;
        fetchProgramAccounts: boolean;
        limit: number;
        port: string;
        ci: boolean;
        json: boolean;
      },
    ) => {
      // Validate programId looks like a base58 pubkey
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(programId)) {
        fail(
          `"${programId}" is not a valid base58 program ID. Provide a 32-44 character base58 string.`,
        );
      }
      await runFork(programId, {
        source: opts.source,
        accounts: opts.accounts,
        fetchProgramAccounts: opts.fetchProgramAccounts,
        limit: opts.limit,
        port: parseInt(opts.port, 10),
        ci: opts.ci,
        json: opts.json,
      });
    },
  );
