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
