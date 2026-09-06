import { z } from "zod";

export const clusterPresetSchema = z
  .object({
    name: z.string(),
    endpoint: z.string().url(),
  })
  .passthrough(); // allow extra metadata fields

export const activeClusterSchema = z.object({
  name: z.string(),
  rpcUrl: z.string(),
});

export type ActiveCluster = z.infer<typeof activeClusterSchema>;

export const nightlyWalletSchema = z.object({
  publicKey: z.string(),
  sessionId: z.string(),
});

export type NightlyWallet = z.infer<typeof nightlyWalletSchema>;

export const globalConfigSchema = z.object({
  // Active cluster name (must match a known preset)
  cluster: z.string().default("cookie"),
  // Full active cluster info (name + resolved RPC URL)
  activeCluster: activeClusterSchema.optional(),
  // Path to the active local keypair file
  walletPath: z.string().optional(),
  // Nightly Connect wallet (for high-stakes confirmations)
  nightlyWallet: nightlyWalletSchema.optional(),
  // Wallet/session placeholders
  wallet: z
    .object({
      keypairPath: z.string().optional(),
      address: z.string().optional(),
      // Reserved for future session tokens
      session: z.unknown().optional(),
    })
    .optional(),
  // User preferences (free-form today; validated loosely)
  preferences: z.record(z.unknown()).optional(),
});

export const projectConfigSchema = z
  .object({
    // Program name (default derived from package name or folder)
    programName: z.string().optional(),
    // Cluster override for this project
    cluster: z.string().optional(),
    // Paths to Anchor programs (array of paths relative to project root)
    programs: z.array(z.string()).optional(),
  })
  .passthrough(); // allow extra per-project keys

export type ClusterPreset = z.infer<typeof clusterPresetSchema>;
export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

// Merged config shape used by the CLI after global + project merge
export const mergedConfigSchema = globalConfigSchema.merge(projectConfigSchema);
export type MergedConfig = z.infer<typeof mergedConfigSchema>;
