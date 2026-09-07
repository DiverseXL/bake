import { Command } from "commander";
import chalk from "chalk";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import { fail } from "../lib/errors.js";
import { getActiveCluster, getConnection } from "../lib/connection.js";
import { resolveProgramIdFromAnchorProject } from "../lib/anchorProject.js";

const DEFAULT_LIMIT = 10;

export interface DecodedLogLine {
  text: string;
  kind: "log" | "data" | "other";
}

/**
 * Basic Anchor log parsing. Event data needs the program's IDL to decode;
 * arbitrary or third-party programs may not publish one. Keep this boundary
 * so an IDL-based decoder can be added without changing command output flow.
 */
export function decodeLogLine(line: string, _idl?: Idl): DecodedLogLine {
  const trimmed = line.trim();
  if (trimmed.startsWith("Program log:")) {
    return { text: trimmed.slice("Program log:".length).trim(), kind: "log" };
  }
  if (trimmed.startsWith("Program data:")) {
    return {
      text: `[data] ${trimmed.slice("Program data:".length).trim()}`,
      kind: "data",
    };
  }
  return { text: trimmed, kind: "other" };
}

interface LogTransaction {
  signature: string;
  timestamp: number | null;
  logs: string[];
}

function isJsonMode(): boolean {
  return process.env.BAKE_JSON === "true";
}

function isCiMode(): boolean {
  return process.env.BAKE_CI === "true";
}

function resolveProgramAddress(programId?: string): PublicKey {
  try {
    if (programId) return new PublicKey(programId);
    const resolved = resolveProgramIdFromAnchorProject();
    if (resolved) return resolved;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  fail(
    "No program ID given and no Anchor.toml found — pass a program ID or run from your program's directory.",
  );
}

function timestampLabel(timestamp: number | null): string {
  return timestamp == null
    ? "time unknown"
    : new Date(timestamp * 1000).toISOString();
}

function formatLogText(text: string): string {
  if (isCiMode() || isJsonMode()) return text;
  return /\b(error|failed)\b/i.test(text) ? chalk.red(text) : text;
}

function printTransaction(transaction: LogTransaction): void {
  console.log(
    `${chalk.dim("─".repeat(60))}\n${chalk.bold(transaction.signature)} ${chalk.dim(
      timestampLabel(transaction.timestamp),
    )}`,
  );
  for (const log of transaction.logs) console.log(formatLogText(log));
}

async function fetchHistory(
  programId: PublicKey,
  limit: number,
): Promise<LogTransaction[]> {
  const connection = getConnection();
  const signatures = await connection.getSignaturesForAddress(
    programId,
    { limit },
    "confirmed",
  );
  const transactions: LogTransaction[] = [];
  for (const signatureInfo of signatures) {
    const transaction = await connection.getTransaction(signatureInfo.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const rawLogs = transaction?.meta?.logMessages;
    if (!rawLogs || rawLogs.length === 0) continue;
    transactions.push({
      signature: signatureInfo.signature,
      timestamp: transaction?.blockTime ?? signatureInfo.blockTime ?? null,
      logs: rawLogs.map((line) => decodeLogLine(line).text),
    });
  }
  return transactions;
}

async function followLogs(programId: PublicKey, clusterName: string): Promise<void> {
  let stopped = false;
  let listenerId: number | null = null;
  const connection = getConnection();
  const onInterrupt = () => {
    stopped = true;
  };
  process.once("SIGINT", onInterrupt);

  try {
    if (!isJsonMode()) {
      console.log(
        `Watching logs for ${programId.toBase58()} on ${clusterName}... (Ctrl+C to stop)`,
      );
    }

    for (let attempt = 0; attempt < 2 && !stopped; attempt += 1) {
      try {
        listenerId = connection.onLogs(
          programId,
          (event) => {
            const transaction: LogTransaction = {
              signature: event.signature,
              timestamp: null,
              logs: (event.logs ?? []).map((line) => decodeLogLine(line).text),
            };
            if (isJsonMode()) {
              // Follow mode is unbounded, so JSON is newline-delimited objects.
              console.log(JSON.stringify(transaction));
            } else {
              printTransaction(transaction);
            }
          },
          "confirmed",
        );
        while (!stopped) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        break;
      } catch (err) {
        if (stopped) break;
        if (attempt === 0) {
          console.error(
            `Warning: log WebSocket connection dropped (${err instanceof Error ? err.message : String(err)}); retrying once...`,
          );
          continue;
        }
        fail(
          `Log WebSocket connection failed after one reconnect attempt: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } finally {
    if (listenerId !== null) {
      await connection.removeOnLogsListener(listenerId);
    }
    process.removeListener("SIGINT", onInterrupt);
    if (stopped && !isJsonMode()) console.log("Stopped watching.");
  }
}

async function runLogs(
  programId: string | undefined,
  options: { follow?: boolean; limit?: string },
): Promise<void> {
  const resolvedProgramId = resolveProgramAddress(programId);
  const cluster = getActiveCluster();
  if (options.follow) {
    await followLogs(resolvedProgramId, cluster.name);
    return;
  }

  const limit = Number(options.limit ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    fail("--limit must be an integer between 1 and 1000.");
  }
  const transactions = await fetchHistory(resolvedProgramId, limit);
  if (transactions.length === 0) {
    if (isJsonMode()) {
      console.error("No logs found yet for this program.");
      console.log("[]");
    } else {
      console.log("No logs found yet for this program.");
    }
    return;
  }
  if (isJsonMode()) {
    console.log(JSON.stringify(transactions));
    return;
  }
  for (const transaction of transactions) printTransaction(transaction);
}

export const logsCommand = new Command("logs")
  .description(
    "Stream decoded program logs; --json with --follow emits newline-delimited JSON",
  )
  .argument("[programId]", "program ID in base58")
  .option("-f, --follow", "watch live logs until Ctrl+C")
  .option(
    "--limit <n>",
    "number of recent transactions to inspect",
    String(DEFAULT_LIMIT),
  )
  .option("--json", "output results as JSON")
  .option("--ci", "disable colors and interactive output")
  .action(
    async (
      programId: string | undefined,
      options: { follow?: boolean; limit?: string; json?: boolean; ci?: boolean },
    ) => {
      if (options.json) process.env.BAKE_JSON = "true";
      if (options.ci) process.env.BAKE_CI = "true";
      try {
        await runLogs(programId, options);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
