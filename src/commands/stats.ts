import { Command } from "commander";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { PublicKey } from "@solana/web3.js";
import type {
  Connection,
  ConfirmedSignatureInfo,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import { fail } from "../lib/errors.js";
import { getActiveCluster, getConnection } from "../lib/connection.js";
import { resolveProgramIdFromAnchorProject } from "../lib/anchorProject.js";

const DEFAULT_LIMIT = 200;
const MAX_SAMPLE_LIMIT = 1000;

// Cookie RPC is not CookieScan's API, but the same ~5-10 req/s courtesy
// applies (per CookieScan's own rate-limit guidance). 8 req/s with a small
// in-flight cap keeps us safely inside that window even for large samples.
const TARGET_REQUESTS_PER_SECOND = 8;
const MAX_IN_FLIGHT_FETCHES = 6;

// Hard cap for --all pagination so a misbehaving RPC can never loop forever.
const MAX_HISTORY_SIGNATURES = 50_000;
const ALL_PAGE_SIZE = 1_000;

// Confirmed CookieScan REST endpoints only (AGENTS.md §5). There is NO
// program-analytics endpoint — network/price context comes from /api/status.
// BAKE_COOKIESCAN_URL overrides the base for testing/degraded-network sims.
const COOKIE_SCAN_BASE_URL =
  process.env.BAKE_COOKIESCAN_URL ?? "https://api.cookiescan.io";
const COOKIE_SCAN_TIMEOUT_MS = 5_000;

function isJsonMode(): boolean {
  return process.env.BAKE_JSON === "true";
}

function isCiMode(): boolean {
  return process.env.BAKE_CI === "true";
}

function resolveProgramAddress(programId?: string): PublicKey {
  try {
    if (programId) return new PublicKey(programId);
    // Same project-location pattern as deploy.ts/prove.ts: Anchor project may
    // be the cwd itself or a sibling anchor/ directory.
    const cwd = existsSync(join(process.cwd(), "Anchor.toml"))
      ? process.cwd()
      : join(process.cwd(), "anchor");
    const resolved = resolveProgramIdFromAnchorProject(cwd);
    if (resolved) return resolved;
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  throw new Error(
    "No program ID given and no Anchor.toml found — pass a program ID or run from your program's directory.",
  );
}

// ---------------------------------------------------------------------------
// Signature fetching
// ---------------------------------------------------------------------------

async function fetchRecentSignatures(
  connection: Connection,
  programId: PublicKey,
  limit: number,
): Promise<ConfirmedSignatureInfo[]> {
  return connection.getSignaturesForAddress(
    programId,
    { limit },
    "confirmed",
  );
}

/**
 * Paginate the program's full signature history using `before` cursors.
 * Capped at MAX_HISTORY_SIGNATURES so a broken RPC cursor can't loop forever.
 */
async function fetchAllSignatures(
  connection: Connection,
  programId: PublicKey,
): Promise<ConfirmedSignatureInfo[]> {
  const all: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  while (all.length < MAX_HISTORY_SIGNATURES) {
    const page = await connection.getSignaturesForAddress(
      programId,
      { before, limit: ALL_PAGE_SIZE },
      "confirmed",
    );
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < ALL_PAGE_SIZE) break;
    const last = page[page.length - 1].signature;
    if (last === before) break; // cursor made no progress — stop
    before = last;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Transaction fetching (concurrency-limited)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch full transactions for a signature list with polite rate limiting:
 * requests are dispatched at a steady TARGET_REQUESTS_PER_SECOND cadence and
 * in-flight requests are capped at MAX_IN_FLIGHT_FETCHES. Individual fetch
 * failures (pruned history, transient RPC errors) resolve to null instead of
 * failing the whole command — the signature-level stats remain valid.
 */
async function fetchTransactions(
  connection: Connection,
  signatures: string[],
): Promise<(VersionedTransactionResponse | null)[]> {
  const results: (VersionedTransactionResponse | null)[] = new Array(
    signatures.length,
  ).fill(null);
  if (signatures.length === 0) return results;

  const intervalMs = 1000 / TARGET_REQUESTS_PER_SECOND;
  const startedAt = Date.now();
  let dispatched = 0;
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= signatures.length) return;

      // Global dispatch cadence: request N goes out at startedAt + N * interval.
      const slot = dispatched;
      dispatched += 1;
      const waitUntil = startedAt + slot * intervalMs;
      const now = Date.now();
      if (waitUntil > now) await sleep(waitUntil - now);

      try {
        results[index] = await connection.getTransaction(signatures[index], {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      } catch {
        results[index] = null;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_IN_FLIGHT_FETCHES, signatures.length) },
      worker,
    ),
  );
  return results;
}

/**
 * Fee payer is always static account key 0 (legacy and versioned messages).
 * Message.getAccountKeys() needs loadedAddresses passed or it drops static
 * keys (v1.98 quirk), so read the raw accountKeys array instead.
 */
function feePayerOf(transaction: VersionedTransactionResponse): string | null {
  const message: unknown = transaction.transaction.message;
  const key = (message as { accountKeys?: PublicKey[] }).accountKeys?.[0];
  return key ? key.toBase58() : null;
}

// ---------------------------------------------------------------------------
// Stats computation
// ---------------------------------------------------------------------------

/** Nearest-rank percentile over an ascending-sorted array. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    Math.max(Math.ceil((q / 100) * sorted.length) - 1, 0),
    sorted.length - 1,
  );
  return sorted[index];
}

export interface NetworkContext {
  cookUsd: number;
  activeTokens: number;
}

export interface StatsResult {
  programId: string;
  sampleSize: number;
  isFullHistory: boolean;
  errorRate: number | null;
  uniqueSigners: number;
  cuPercentiles: { p50: number; p95: number; p99: number } | null;
  oldestTx: string | null;
  newestTx: string | null;
  network: NetworkContext | null;
  /** Internal: number of signatures whose full tx could not be fetched. */
  unfetchable?: number;
}

/**
 * Core stats computation (no CLI prompts/printing). Used by `bake stats` and MCP.
 */
export async function collectProgramStats(
  programId?: string,
  options: { limit?: number; all?: boolean } = {},
): Promise<StatsResult> {
  const resolvedProgramId = resolveProgramAddress(programId);
  const limit = options.all
    ? MAX_SAMPLE_LIMIT
    : Math.min(
        Math.max(1, options.limit ?? DEFAULT_LIMIT),
        MAX_SAMPLE_LIMIT,
      );

  const connection = getConnection();
  const signatures = options.all
    ? await fetchAllSignatures(connection, resolvedProgramId)
    : await fetchRecentSignatures(connection, resolvedProgramId, limit);

  if (signatures.length === 0) {
    return {
      programId: resolvedProgramId.toBase58(),
      sampleSize: 0,
      isFullHistory: options.all === true,
      errorRate: null,
      uniqueSigners: 0,
      cuPercentiles: null,
      oldestTx: null,
      newestTx: null,
      network: await fetchNetworkContext(),
    };
  }

  const failedCount = signatures.filter((sig) => sig.err != null).length;
  const errorRate = (failedCount / signatures.length) * 100;

  const transactions = await fetchTransactions(
    connection,
    signatures.map((sig) => sig.signature),
  );
  const signers = new Set<string>();
  const cuValues: number[] = [];
  for (const tx of transactions) {
    if (!tx) continue;
    const payer = feePayerOf(tx);
    if (payer) signers.add(payer);
    const cu = tx.meta?.computeUnitsConsumed;
    if (typeof cu === "number") cuValues.push(cu);
  }
  cuValues.sort((a, b) => a - b);
  const cuPercentiles =
    cuValues.length > 0
      ? {
          p50: percentile(cuValues, 50),
          p95: percentile(cuValues, 95),
          p99: percentile(cuValues, 99),
        }
      : null;

  const blockTimes = signatures
    .map((sig) => sig.blockTime)
    .filter((t): t is number => typeof t === "number");
  const oldestBlockTime = blockTimes.length > 0 ? Math.min(...blockTimes) : null;
  const newestBlockTime = blockTimes.length > 0 ? Math.max(...blockTimes) : null;

  return {
    programId: resolvedProgramId.toBase58(),
    sampleSize: signatures.length,
    isFullHistory: options.all === true,
    errorRate,
    uniqueSigners: signers.size,
    cuPercentiles,
    oldestTx: toIso(oldestBlockTime),
    newestTx: toIso(newestBlockTime),
    network: await fetchNetworkContext(),
    unfetchable: transactions.filter((tx) => tx === null).length,
  };
}

/**
 * Optional supplementary context from CookieScan's REST API (network-wide,
 * NOT program-specific). Failures degrade to null — program stats must not
 * depend on this call (AGENTS.md §5).
 */
async function fetchNetworkContext(): Promise<NetworkContext | null> {
  try {
    const response = await fetch(`${COOKIE_SCAN_BASE_URL}/api/status`, {
      signal: AbortSignal.timeout(COOKIE_SCAN_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const raw: unknown = await response.json();
    const status = raw as { cookUsd?: unknown; activeTokens?: unknown };
    if (typeof status.cookUsd !== "number" || typeof status.activeTokens !== "number") {
      throw new Error("unexpected /api/status response shape");
    }
    return { cookUsd: status.cookUsd, activeTokens: status.activeTokens };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      chalk.yellow(
        `⚠ CookieScan network context unavailable (${message}) — skipping that section; program stats above are unaffected.`,
      ),
    );
    return null;
  }
}

function toIso(timestamp: number | null | undefined): string | null {
  return typeof timestamp === "number"
    ? new Date(timestamp * 1000).toISOString()
    : null;
}

async function runStats(
  programId: string | undefined,
  options: {
    limit?: string;
    all?: boolean;
    yesIKnowThisMayBeSlow?: boolean;
  },
): Promise<void> {
  const resolvedProgramId = resolveProgramAddress(programId);
  const cluster = getActiveCluster();

  let limit = DEFAULT_LIMIT;
  if (!options.all) {
    limit = Number(options.limit ?? DEFAULT_LIMIT);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SAMPLE_LIMIT) {
      fail(`--limit must be an integer between 1 and ${MAX_SAMPLE_LIMIT}.`);
    }
  }

  // --all walks the FULL history: warn loudly, require explicit confirmation
  // interactively (AGENTS.md §7), but never hang in --ci/--json/non-TTY runs.
  if (options.all && !options.yesIKnowThisMayBeSlow) {
    const warning =
      "⚠ --all paginates the program's ENTIRE transaction history. This can " +
      "be slow and rate-limit-prone for active programs.";
    if (isJsonMode() || isCiMode() || !process.stdin.isTTY) {
      console.error(`${warning} Proceeding anyway.`);
    } else {
      console.error(warning);
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question("Proceed with full-history scan? [y/N] ");
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.error("Aborted — pass --yes-i-know-this-may-be-slow to skip this prompt.");
          return;
        }
      } finally {
        rl.close();
      }
    }
  }

  const connection = getConnection();

  const signatures = options.all
    ? await fetchAllSignatures(connection, resolvedProgramId)
    : await fetchRecentSignatures(connection, resolvedProgramId, limit);

  if (signatures.length === 0) {
    // Same friendly pattern as logs.ts: message to stderr in JSON mode, plain
    // stdout message otherwise — never a crash or confusing empty output.
    if (isJsonMode()) {
      console.error("No transactions found yet for this program.");
      const empty: StatsResult = {
        programId: resolvedProgramId.toBase58(),
        sampleSize: 0,
        isFullHistory: options.all === true,
        errorRate: null,
        uniqueSigners: 0,
        cuPercentiles: null,
        oldestTx: null,
        newestTx: null,
        network: null,
      };
      console.log(JSON.stringify(empty));
    } else {
      console.log("No transactions found yet for this program.");
    }
    return;
  }

  // Error rate comes straight from the signature list — no full-tx fetches
  // wasted just for this.
  const failedCount = signatures.filter((sig) => sig.err != null).length;
  const errorRate = (failedCount / signatures.length) * 100;

  // Unique signers + CU percentiles need full transactions.
  const transactions = await fetchTransactions(
    connection,
    signatures.map((sig) => sig.signature),
  );
  const signers = new Set<string>();
  const cuValues: number[] = [];
  for (const tx of transactions) {
    if (!tx) continue;
    const payer = feePayerOf(tx);
    if (payer) signers.add(payer);
    const cu = tx.meta?.computeUnitsConsumed;
    if (typeof cu === "number") cuValues.push(cu);
  }
  cuValues.sort((a, b) => a - b);
  const cuPercentiles =
    cuValues.length > 0
      ? {
          p50: percentile(cuValues, 50),
          p95: percentile(cuValues, 95),
          p99: percentile(cuValues, 99),
        }
      : null;

  const blockTimes = signatures
    .map((sig) => sig.blockTime)
    .filter((t): t is number => typeof t === "number");
  const oldestBlockTime = blockTimes.length > 0 ? Math.min(...blockTimes) : null;
  const newestBlockTime = blockTimes.length > 0 ? Math.max(...blockTimes) : null;

  const network = await fetchNetworkContext();

  const unfetchable = transactions.filter((tx) => tx === null).length;
  const result: StatsResult = {
    programId: resolvedProgramId.toBase58(),
    sampleSize: signatures.length,
    isFullHistory: options.all === true,
    errorRate,
    uniqueSigners: signers.size,
    cuPercentiles,
    oldestTx: toIso(oldestBlockTime),
    newestTx: toIso(newestBlockTime),
    network,
    unfetchable,
  };

  if (isJsonMode()) {
    const { unfetchable: _omit, ...json } = result;
    console.log(JSON.stringify(json));
    return;
  }

  const sampleLabel = options.all
    ? "full history"
    : `recent sample of up to ${limit} — use --all for full history`;

  console.log();
  console.log(
    `${chalk.bold("Program Activity")} ${chalk.dim("—")} ${chalk.bold(
      resolvedProgramId.toBase58(),
    )} ${chalk.dim(`(${cluster.name} · ${cluster.rpcUrl})`)}`,
  );
  console.log(`  ${chalk.dim("Transactions analyzed:")}  ${signatures.length.toLocaleString("en-US")}  ${chalk.dim(`(${sampleLabel})`)}`);
  console.log(
    `  ${chalk.dim("Error rate:")}             ${errorRate.toFixed(1)}% ${chalk.dim(`(${failedCount} failed of ${signatures.length})`)}`,
  );
  console.log(`  ${chalk.dim("Unique signers:")}          ${signers.size.toLocaleString("en-US")}`);
  if (cuPercentiles) {
    console.log(
      `  ${chalk.dim("CU p50 / p95 / p99:")}      ${cuPercentiles.p50.toLocaleString("en-US")} / ${cuPercentiles.p95.toLocaleString("en-US")} / ${cuPercentiles.p99.toLocaleString("en-US")}`,
    );
  } else {
    console.log(`  ${chalk.dim("CU p50 / p95 / p99:")}      n/a (no transaction details available)`);
  }
  console.log(
    `  ${chalk.dim("Time range:")}              ${
      result.oldestTx ?? "time unknown"
    } → ${result.newestTx ?? "time unknown"}`,
  );
  if (unfetchable > 0) {
    console.log(
      `  ${chalk.dim(`Note: ${unfetchable} of ${signatures.length} transaction(s) could not be fetched for signer/CU detail (history may be pruned); signature-level stats are still complete.`)}`,
    );
  }

  console.log();
  if (network) {
    console.log(
      `${chalk.bold("Network Context")} ${chalk.dim("— CookieScan, network-wide (NOT program-specific)")}`,
    );
    console.log(
      `  ${chalk.dim("COOK price:")}      $${network.cookUsd.toLocaleString("en-US", { maximumFractionDigits: 10 })}`,
    );
    console.log(
      `  ${chalk.dim("Active tokens:")}   ${network.activeTokens.toLocaleString("en-US")}`,
    );
  }
  console.log();
}

export const statsCommand = new Command("stats")
  .description("Program activity stats from RPC, plus CookieScan network context")
  .argument("[programId]", "program ID in base58")
  .option(
    "--limit <n>",
    `number of recent signatures to analyze (default ${DEFAULT_LIMIT})`,
    String(DEFAULT_LIMIT),
  )
  .option(
    "--all",
    "analyze the full transaction history (overrides --limit; can be slow)",
  )
  .option(
    "--yes-i-know-this-may-be-slow",
    "skip the confirmation prompt for --all",
  )
  .option("--json", "output results as JSON")
  .option("--ci", "disable colors and interactive output")
  .action(
    async (
      programId: string | undefined,
      options: {
        limit?: string;
        all?: boolean;
        yesIKnowThisMayBeSlow?: boolean;
        json?: boolean;
        ci?: boolean;
      },
    ) => {
      if (options.json) process.env.BAKE_JSON = "true";
      if (options.ci) process.env.BAKE_CI = "true";
      try {
        await runStats(programId, options);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
