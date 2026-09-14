import { z } from "zod";
import type { ClusterPreset } from "../config/types.js";
import { clusterPresetSchema } from "../config/types.js";

// Preset registry. Add new clusters here to keep a single source of truth.
export const CLUSTERS: Record<string, ClusterPreset> = {
  cookie: {
    name: "cookie",
    endpoint: "https://rpc.cookiescan.io",
  },
  mainnet: {
    name: "mainnet",
    endpoint: "https://api.mainnet-beta.solana.com",
  },
  devnet: {
    name: "devnet",
    endpoint: "https://api.devnet.solana.com",
  },
};

// Zod schema that validates an incoming cluster name against known presets.
export const knownClusterSchema = z
  .object({
    name: z.string(),
    endpoint: z.string().url(),
  })
  .refine((cluster) => cluster.name in CLUSTERS, {
    message: "Unknown cluster",
  });

export function getCluster(name: string): ClusterPreset {
  const normalized = name.toLowerCase();
  const preset = CLUSTERS[normalized];
  if (!preset) {
    const known = Object.keys(CLUSTERS).join(", ");
    throw new Error(
      `Unknown cluster "${name}". Known clusters: ${known}`
    );
  }
  return preset;
}

export function listClusters(): string[] {
  return Object.keys(CLUSTERS);
}

export function clusterExists(name: string): boolean {
  return name.toLowerCase() in CLUSTERS;
}

/**
 * Checks if a persisted cluster config uses a known preset name but has an RPC URL
 * that differs from the preset's current definition in the CLUSTERS registry.
 * Returns a warning string if stale, or null if up to date / custom.
 */
export function getStalePresetWarning(active: { name: string; rpcUrl: string }): string | null {
  const lower = active.name.toLowerCase();
  if (clusterExists(lower)) {
    const preset = CLUSTERS[lower];
    if (active.rpcUrl !== preset.endpoint) {
      return `⚠ Your saved '${active.name}' cluster URL doesn't match the current preset — run \`bake use ${active.name}\` to refresh it.`;
    }
  }
  return null;
}

