/**
 * Connection factory for Cookie Chain / Solana-compatible clusters.
 *
 * Exports helpers that resolve the active cluster from global config
 * and create RPC connections using @solana/web3.js v2.
 */
import { createSolanaRpc } from "@solana/web3.js";
import { readGlobalConfig } from "../config/index.js";
import { CLUSTERS, clusterExists } from "../clusters/index.js";
import type { ActiveCluster } from "../config/types.js";

const DEFAULT_CLUSTER_NAME = "cookie";

/** Return type of createSolanaRpc – inferred so we stay decoupled from internals. */
export type SolanaRpc = ReturnType<typeof createSolanaRpc>;

/**
 * Returns the currently active cluster from the global config.
 * Falls back to the "cookie" preset if nothing is configured.
 */
export function getActiveCluster(): ActiveCluster {
  const cfg = readGlobalConfig();
  if (cfg?.activeCluster) {
    return { name: cfg.activeCluster.name, rpcUrl: cfg.activeCluster.rpcUrl };
  }
  // Default to the cookie preset
  const preset = CLUSTERS[DEFAULT_CLUSTER_NAME];
  return { name: preset.name, rpcUrl: preset.endpoint };
}

/**
 * Creates an RPC connection for the active cluster (or an override).
 *
 * @param clusterOverride  Either a known preset name ("cookie", "mainnet", …)
 *                         or a full RPC URL. When provided, it takes priority
 *                         over the persisted active cluster.
 */
export function getConnection(clusterOverride?: string): SolanaRpc {
  let rpcUrl: string;

  if (clusterOverride) {
    if (clusterOverride.startsWith("http://") || clusterOverride.startsWith("https://")) {
      rpcUrl = clusterOverride;
    } else if (clusterExists(clusterOverride)) {
      rpcUrl = CLUSTERS[clusterOverride.toLowerCase()].endpoint;
    } else {
      // Fall back to active cluster if override is unrecognised
      const active = getActiveCluster();
      rpcUrl = active.rpcUrl;
    }
  } else {
    const active = getActiveCluster();
    rpcUrl = active.rpcUrl;
  }

  return createSolanaRpc(rpcUrl);
}
