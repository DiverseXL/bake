import { Command } from "commander";
import chalk from "chalk";
import { CLUSTERS, clusterExists } from "../clusters/index.js";
import { readGlobalConfig, writeGlobalConfig } from "../config/index.js";
import { getActiveCluster, getConnection } from "../lib/connection.js";
import { fail, formatUserError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import type { ActiveCluster } from "../config/types.js";

const TIMEOUT_MS = 3_000;

function isValidUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

/**
 * Attempt to call getSlot() on an RPC endpoint with a timeout.
 * Returns the slot number or `null` if unreachable / error.
 */
async function probeSlot(rpcUrl: string): Promise<bigint | null> {
  try {
    const rpc = createSolanaRpc(rpcUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // @solana/web3.js v2: getSlot() returns a plan; call .send({ abortSignal })
    const slot = await rpc.getSlot().send({ abortSignal: controller.signal });
    clearTimeout(timer);
    return slot;
  } catch {
    return null;
  }
}

// Lazy import to keep module-level side effects minimal
import { createSolanaRpc } from "@solana/web3.js";

interface UseResult {
  cluster: string;
  rpcUrl: string;
  slot: number | null;
  reachable: boolean;
}

/**
 * Resolve a user-supplied cluster string into { name, rpcUrl }.
 * Returns `null` and prints an error when the input is invalid.
 */
function resolveClusterInput(input: string): ActiveCluster | null {
  const lower = input.toLowerCase();

  // Known preset?
  if (clusterExists(lower)) {
    const preset = CLUSTERS[lower];
    return { name: preset.name, rpcUrl: preset.endpoint };
  }

  // Custom URL?
  if (isValidUrl(input)) {
    return { name: "custom", rpcUrl: input };
  }

  // Neither – bail with a friendly message
  const known = Object.keys(CLUSTERS).join(", ");
  fail(`Unknown cluster "${input}". Valid presets: ${known}, or pass a full RPC URL (https://...).`);
}

function printHumanResult(result: UseResult, wasAlreadyActive: boolean): void {
  if (wasAlreadyActive) {
    logger.info(
      `\nActive cluster is already ${chalk.bold(result.cluster)} (${chalk.dim(result.rpcUrl)})\n`
    );
  } else {
    logger.success(
      `\nSwitched to cluster ${chalk.bold(result.cluster)} (${result.rpcUrl})\n`
    );
  }

  if (result.reachable) {
    logger.success(`  Current slot: ${result.slot}`);
  } else {
    logger.warn(`  ⚠ Could not reach ${result.rpcUrl} – cluster saved but may be offline.`);
  }
}

async function runUse(input?: string): Promise<void> {
  // No argument → show current active cluster
  if (!input) {
    const active = getActiveCluster();
    const cfg = readGlobalConfig();
    const hasExplicit = cfg?.activeCluster != null;

    if (process.env.BAKE_JSON === "true") {
      // Probe slot for JSON output too
      const slot = await probeSlot(active.rpcUrl);
      const output: UseResult = {
        cluster: active.name,
        rpcUrl: active.rpcUrl,
        slot: slot != null ? Number(slot) : null,
        reachable: slot != null,
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    if (hasExplicit) {
      logger.info(`\nActive cluster: ${chalk.bold(active.name)} (${active.rpcUrl})\n`);
    } else {
      logger.info(
        `\nNo cluster set. Using default: ${chalk.bold(active.name)} (${active.rpcUrl})\n`
      );
    }

    // Probe for informational slot
    const slot = await probeSlot(active.rpcUrl);
    if (slot != null) {
      logger.success(`  Current slot: ${slot}`);
    } else {
      logger.warn(`  ⚠ Could not reach ${active.rpcUrl} right now.`);
    }
    return;
  }

  // With argument → switch cluster
  const target = resolveClusterInput(input);
  // resolveClusterInput calls fail() which never returns when invalid

  const current = getActiveCluster();
  const wasAlreadyActive =
    current.name === target!.name && current.rpcUrl === target!.rpcUrl;

  // Persist to global config
  const existingGlobal = readGlobalConfig();
  const globalData: Record<string, unknown> = existingGlobal
    ? { ...existingGlobal }
    : {};
  globalData.activeCluster = { name: target!.name, rpcUrl: target!.rpcUrl };
  writeGlobalConfig(globalData);

  // Probe slot
  const slot = await probeSlot(target!.rpcUrl);
  const reachable = slot != null;

  const result: UseResult = {
    cluster: target!.name,
    rpcUrl: target!.rpcUrl,
    slot: slot != null ? Number(slot) : null,
    reachable,
  };

  if (process.env.BAKE_JSON === "true") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printHumanResult(result, wasAlreadyActive);
}

export const useCommand = new Command("use")
  .description("Switch active cluster or show the current one")
  .argument("[cluster]", "Cluster name (cookie, mainnet, devnet) or RPC URL")
  .action(async (cluster?: string) => {
    await runUse(cluster);
  });
