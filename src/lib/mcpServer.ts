import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readGlobalConfig } from "../config/index.js";
import { collectProgramStats } from "../commands/stats.js";
import { fetchProgramLogHistory } from "../commands/logs.js";
import { resolveProgramIdFromAnchorProject } from "./anchorProject.js";
import { getActiveCluster } from "./connection.js";
import { getCookieTokenInfo } from "./cookieMcpClient.js";
import {
  bytesToHex,
  fetchOnChainBytecodeHash,
  runDeployPipeline,
  type DeployPipelineResult,
} from "./deployPipeline.js";
import { getCurrentCommit, getGitRemote } from "./git.js";
import {
  isProgramAllowed,
  type LoadedMcpPolicy,
  type McpPolicy,
} from "./mcpPolicy.js";
import { getRecipeBookClient } from "./recipeBook.js";
import {
  resolveAnchorProjectCwd,
  runRollbackPipeline,
  type RollbackPipelineResult,
} from "./rollbackPipeline.js";
import { resolveWalletPath } from "./wallet.js";

// ---------------------------------------------------------------------------
// Constants / types
// ---------------------------------------------------------------------------

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
import { VERSION } from "./version.js";

type PendingAction =
  | {
      kind: "deploy";
      cwd: string;
      programId: string;
      commit: string;
      cluster: string;
      rpcUrl: string;
      createdAt: number;
    }
  | {
      kind: "rollback";
      cwd: string;
      programId: string;
      entryIndex?: number;
      commit: string;
      cluster: string;
      rpcUrl: string;
      createdAt: number;
    };

export type McpWriteExecutors = {
  deploy: (cwd: string) => Promise<DeployPipelineResult>;
  rollback: (
    cwd: string,
    entryIndex?: number,
  ) => Promise<RollbackPipelineResult>;
};

export interface BakeMcpServerOptions {
  cwd?: string;
  loaded: LoadedMcpPolicy;
  /** Override write executors (tests). Defaults to real pipeline functions. */
  executors?: Partial<McpWriteExecutors>;
}

function auditLog(message: string): void {
  const ts = new Date().toISOString();
  console.error(`[bake-mcp ${ts}] ${message}`);
}

function jsonResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

function resolveProjectCwd(cwd: string): string {
  try {
    return resolveAnchorProjectCwd(cwd);
  } catch {
    if (existsSync(join(cwd, "Anchor.toml"))) return cwd;
    return cwd;
  }
}

function resolveProgramIdString(
  cwd: string,
  programIdArg?: string,
): string {
  if (programIdArg) {
    // Validate base58
    return new PublicKey(programIdArg).toBase58();
  }
  const projectCwd = resolveProjectCwd(cwd);
  const id = resolveProgramIdFromAnchorProject(projectCwd);
  if (!id) {
    throw new Error(
      "No program ID given and none found in the Anchor project.",
    );
  }
  return id.toBase58();
}

// ---------------------------------------------------------------------------
// Level-1 prove (no --rebuild / no git mutation)
// ---------------------------------------------------------------------------

async function proveLevel1(
  cwd: string,
  entryIndexArg?: number,
): Promise<Record<string, unknown>> {
  const projectCwd = resolveAnchorProjectCwd(cwd);
  const programId = resolveProgramIdFromAnchorProject(projectCwd);
  if (!programId) {
    throw new Error("No program ID found in the Anchor project.");
  }

  const client = getRecipeBookClient();
  const entries = (await client.getEntries(programId)).sort(
    (a, b) => a.index - b.index,
  );
  if (entries.length === 0) {
    throw new Error("No Recipe Book entries exist — deploy something first.");
  }

  let targetIndex: number;
  if (entryIndexArg !== undefined) {
    targetIndex = entryIndexArg;
    if (targetIndex < 0 || targetIndex >= entries.length) {
      throw new Error(
        `Entry #${targetIndex} does not exist — Recipe Book has entries 0–${entries.length - 1}.`,
      );
    }
  } else {
    targetIndex = entries.length - 1;
  }

  const target = entries[targetIndex];
  const recordedHash = bytesToHex(target.buildHash);
  const onChainHash = await fetchOnChainBytecodeHash(programId);
  const onChainMatch = recordedHash === onChainHash;

  return {
    entryIndex: target.index,
    commit: target.commit,
    repo: target.repo,
    recordedHash,
    onChainHash,
    onChainMatch,
    rebuiltHash: null,
    rebuildMatch: null,
    fullyVerified: false,
    note: "MCP bake_prove is Level 1 only (on-chain hash check). Use CLI `bake prove --rebuild` for reproducibility.",
  };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createBakeMcpServer(options: BakeMcpServerOptions): McpServer {
  const cwd = options.cwd ?? process.cwd();
  const policy: McpPolicy = options.loaded.policy;
  const writesEnabled = policy.allowWrites === true;

  const executors: McpWriteExecutors = {
    deploy: options.executors?.deploy ?? runDeployPipeline,
    rollback: options.executors?.rollback ?? runRollbackPipeline,
  };

  let writesExecutedThisSession = 0;
  const pending = new Map<string, PendingAction>();

  const server = new McpServer({
    name: "bake",
    version: VERSION,
  });

  function purgeExpiredPending(): void {
    const now = Date.now();
    for (const [token, action] of pending) {
      if (now - action.createdAt > CONFIRMATION_TTL_MS) {
        pending.delete(token);
      }
    }
  }

  function assertWriteBudget(tool: string): void {
    if (writesExecutedThisSession >= policy.maxDeploysPerSession) {
      throw new Error(
        `Session write limit reached (${policy.maxDeploysPerSession}). ` +
          `${tool} refused — restart the MCP server to reset the counter, or raise maxDeploysPerSession in the policy file.`,
      );
    }
  }

  function assertProgramWriteAllowed(programId: string, tool: string): void {
    if (!isProgramAllowed(policy, programId)) {
      throw new Error(
        `${tool} refused — program ${programId} is not in allowedPrograms.`,
      );
    }
  }

  // ── READ-ONLY tools (always registered) ─────────────────────────────────

  server.registerTool(
    "bake_whoami",
    {
      description: "Show active bake wallet(s) and cluster",
      inputSchema: {},
    },
    async () => {
      const cfg = readGlobalConfig();
      const cluster = getActiveCluster();
      return jsonResult({
        localWallet: resolveWalletPath() ?? cfg?.walletPath ?? null,
        nightlyWallet: cfg?.nightlyWallet?.publicKey ?? null,
        cluster: cluster.name,
        rpcUrl: cluster.rpcUrl,
      });
    },
  );

  server.registerTool(
    "bake_stats",
    {
      description:
        "Program activity stats from RPC + CookieScan network context (not program analytics)",
      inputSchema: {
        programId: z
          .string()
          .optional()
          .describe("Program ID (base58); defaults to Anchor project program"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Recent signature sample size (default 200)"),
      },
    },
    async (args) => {
      try {
        const stats = await collectProgramStats(args.programId, {
          limit: args.limit,
        });
        const { unfetchable: _omit, ...rest } = stats;
        return jsonResult(rest);
      } catch (err) {
        return jsonResult(
          { error: err instanceof Error ? err.message : String(err) },
          true,
        );
      }
    },
  );

  server.registerTool(
    "bake_prove",
    {
      description:
        "Level 1 prove: compare Recipe Book recorded hash to on-chain bytecode (no --rebuild)",
      inputSchema: {
        entryIndex: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Recipe Book entry index (default: latest)"),
      },
    },
    async (args) => {
      try {
        return jsonResult(await proveLevel1(cwd, args.entryIndex));
      } catch (err) {
        return jsonResult(
          { error: err instanceof Error ? err.message : String(err) },
          true,
        );
      }
    },
  );

  server.registerTool(
    "bake_logs",
    {
      description:
        "Fetch recent program logs (history only — not a live --follow stream)",
      inputSchema: {
        programId: z.string().optional().describe("Program ID (base58)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Number of recent transactions (default 10)"),
      },
    },
    async (args) => {
      try {
        const id = resolveProgramIdString(cwd, args.programId);
        const txs = await fetchProgramLogHistory(
          new PublicKey(id),
          args.limit ?? 10,
        );
        return jsonResult(txs);
      } catch (err) {
        return jsonResult(
          { error: err instanceof Error ? err.message : String(err) },
          true,
        );
      }
    },
  );

  server.registerTool(
    "bake_get_history",
    {
      description: "List Recipe Book deploy entries for a program",
      inputSchema: {
        programId: z
          .string()
          .optional()
          .describe("Program ID (base58); defaults to Anchor project program"),
      },
    },
    async (args) => {
      try {
        const id = resolveProgramIdString(cwd, args.programId);
        const client = getRecipeBookClient();
        const entries = await client.getEntries(new PublicKey(id));
        return jsonResult(
          entries
            .sort((a, b) => a.index - b.index)
            .map((e) => ({
              index: e.index,
              repo: e.repo,
              commit: e.commit,
              buildHash: bytesToHex(e.buildHash),
              buffer: e.buffer.toBase58(),
              deployer: e.deployer.toBase58(),
              timestamp: e.timestamp,
            })),
        );
      } catch (err) {
        return jsonResult(
          { error: err instanceof Error ? err.message : String(err) },
          true,
        );
      }
    },
  );

  server.registerTool(
    "bake_check_token_liquidity",
    {
      description:
        "Check token liquidity info via cookie-mcp (price, pools, launchpad status). Accepts a mint address or token symbol/name.",
      inputSchema: {
        mintOrSymbol: z
          .string()
          .describe("Token mint address (base58) or symbol/name to look up"),
      },
    },
    async (args) => {
      try {
        const info = await getCookieTokenInfo(args.mintOrSymbol);
        return jsonResult({
          mint: info.mint,
          symbol: info.symbol,
          name: info.name,
          priceUsd: info.priceUsd,
          hasLiquidity: info.hasLiquidity,
          isOnLaunchpad: info.isOnLaunchpad,
          pools: info.pools,
        });
      } catch (err) {
        return jsonResult(
          { error: err instanceof Error ? err.message : String(err) },
          true,
        );
      }
    },
  );

  // ── WRITE tools (only when policy.allowWrites) ───────────────────────────

  if (writesEnabled) {
    server.registerTool(
      "bake_deploy",
      {
        description:
          "Deploy the Anchor program via bake's shared deploy pipeline (may require confirmation)",
        inputSchema: {
          cwd: z
            .string()
            .optional()
            .describe("Project directory (default: MCP server cwd)"),
        },
      },
      async (args) => {
        const tool = "bake_deploy";
        auditLog(`${tool} attempted`);
        try {
          assertWriteBudget(tool);
          const projectCwd = resolveProjectCwd(args.cwd ?? cwd);
          const programId = resolveProgramIdString(projectCwd);
          assertProgramWriteAllowed(programId, tool);

          const cluster = getActiveCluster();
          const commit = await getCurrentCommit(projectCwd).catch(() => "unknown");
          const repo = await getGitRemote(projectCwd).catch(() => "local");

          const preview = {
            action: "deploy" as const,
            programId,
            commit,
            repo,
            cluster: cluster.name,
            rpcUrl: cluster.rpcUrl,
            estimatedCost:
              "Variable — Anchor deploy + Recipe Book register_deploy tx fees on the active cluster",
            writesUsedThisSession: writesExecutedThisSession,
            maxDeploysPerSession: policy.maxDeploysPerSession,
          };

          if (policy.requireConfirmation) {
            purgeExpiredPending();
            const token = randomBytes(16).toString("hex");
            pending.set(token, {
              kind: "deploy",
              cwd: projectCwd,
              programId,
              commit,
              cluster: cluster.name,
              rpcUrl: cluster.rpcUrl,
              createdAt: Date.now(),
            });
            auditLog(
              `${tool} deferred — confirmation required (token=${token.slice(0, 8)}…)`,
            );
            return jsonResult({
              status: "confirmation_required",
              confirmationToken: token,
              expiresInSeconds: CONFIRMATION_TTL_MS / 1000,
              preview,
              nextStep:
                "Call bake_confirm_action with this confirmationToken within the expiry window to execute.",
            });
          }

          const result = await executors.deploy(projectCwd);
          writesExecutedThisSession += 1;
          auditLog(
            `${tool} executed program=${result.programId.toBase58()} entry=#${result.entryIndex} sessionWrites=${writesExecutedThisSession}`,
          );
          return jsonResult({
            status: "executed",
            programId: result.programId.toBase58(),
            deploySignature: result.deploySignature,
            entryIndex: result.entryIndex,
            mock: result.mock,
            commit: result.commit,
            cluster: cluster.name,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          auditLog(`${tool} refused/failed: ${msg}`);
          return jsonResult({ error: msg }, true);
        }
      },
    );

    server.registerTool(
      "bake_rollback",
      {
        description:
          "Roll back to a prior Recipe Book entry (git checkout + redeploy; may require confirmation)",
        inputSchema: {
          entryIndex: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Target entry index (default: undo last deploy)"),
          cwd: z.string().optional().describe("Project directory"),
        },
      },
      async (args) => {
        const tool = "bake_rollback";
        auditLog(`${tool} attempted`);
        try {
          assertWriteBudget(tool);
          const projectCwd = resolveProjectCwd(args.cwd ?? cwd);
          const programId = resolveProgramIdString(projectCwd);
          assertProgramWriteAllowed(programId, tool);

          const client = getRecipeBookClient();
          const entries = (await client.getEntries(new PublicKey(programId))).sort(
            (a, b) => a.index - b.index,
          );
          let targetIndex: number;
          if (args.entryIndex !== undefined) {
            targetIndex = args.entryIndex;
          } else {
            if (entries.length < 2) {
              throw new Error("Nothing to roll back to — only one deploy exists.");
            }
            targetIndex = entries.length - 2;
          }
          if (targetIndex < 0 || targetIndex >= entries.length) {
            throw new Error(`Entry #${targetIndex} does not exist.`);
          }
          const target = entries[targetIndex];
          const cluster = getActiveCluster();

          const preview = {
            action: "rollback" as const,
            programId,
            entryIndex: target.index,
            commit: target.commit,
            repo: target.repo,
            cluster: cluster.name,
            rpcUrl: cluster.rpcUrl,
            estimatedCost:
              "Variable — rebuild/redeploy fees; mutates git checkout temporarily then restores",
            writesUsedThisSession: writesExecutedThisSession,
            maxDeploysPerSession: policy.maxDeploysPerSession,
          };

          if (policy.requireConfirmation) {
            purgeExpiredPending();
            const token = randomBytes(16).toString("hex");
            pending.set(token, {
              kind: "rollback",
              cwd: projectCwd,
              programId,
              entryIndex: args.entryIndex,
              commit: target.commit,
              cluster: cluster.name,
              rpcUrl: cluster.rpcUrl,
              createdAt: Date.now(),
            });
            auditLog(
              `${tool} deferred — confirmation required (token=${token.slice(0, 8)}…)`,
            );
            return jsonResult({
              status: "confirmation_required",
              confirmationToken: token,
              expiresInSeconds: CONFIRMATION_TTL_MS / 1000,
              preview,
              nextStep:
                "Call bake_confirm_action with this confirmationToken within the expiry window to execute.",
            });
          }

          const result = await executors.rollback(projectCwd, args.entryIndex);
          writesExecutedThisSession += 1;
          auditLog(
            `${tool} executed program=${result.programId} to entry=#${result.rolledBackToEntry} sessionWrites=${writesExecutedThisSession}`,
          );
          return jsonResult({ status: "executed", ...result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          auditLog(`${tool} refused/failed: ${msg}`);
          return jsonResult({ error: msg }, true);
        }
      },
    );

    server.registerTool(
      "bake_confirm_action",
      {
        description:
          "Execute a previously previewed write action using its confirmation token (human-in-the-loop)",
        inputSchema: {
          confirmationToken: z
            .string()
            .describe("Token returned by bake_deploy or bake_rollback"),
        },
      },
      async (args) => {
        const tool = "bake_confirm_action";
        auditLog(`${tool} attempted token=${args.confirmationToken.slice(0, 8)}…`);
        try {
          purgeExpiredPending();
          const action = pending.get(args.confirmationToken);
          if (!action) {
            throw new Error(
              "Invalid or expired confirmation token. Call bake_deploy/bake_rollback again to get a fresh token.",
            );
          }
          pending.delete(args.confirmationToken);
          assertWriteBudget(tool);
          assertProgramWriteAllowed(action.programId, tool);

          if (action.kind === "deploy") {
            const result = await executors.deploy(action.cwd);
            writesExecutedThisSession += 1;
            auditLog(
              `${tool} executed deploy program=${result.programId.toBase58()} entry=#${result.entryIndex} sessionWrites=${writesExecutedThisSession}`,
            );
            return jsonResult({
              status: "executed",
              action: "deploy",
              programId: result.programId.toBase58(),
              deploySignature: result.deploySignature,
              entryIndex: result.entryIndex,
              mock: result.mock,
              commit: result.commit,
            });
          }

          const result = await executors.rollback(
            action.cwd,
            action.entryIndex,
          );
          writesExecutedThisSession += 1;
          auditLog(
            `${tool} executed rollback program=${result.programId} to entry=#${result.rolledBackToEntry} sessionWrites=${writesExecutedThisSession}`,
          );
          return jsonResult({ status: "executed", action: "rollback", ...result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          auditLog(`${tool} refused/failed: ${msg}`);
          return jsonResult({ error: msg }, true);
        }
      },
    );
  }

  return server;
}

export function printMcpStartupSummary(loaded: LoadedMcpPolicy): void {
  const { policy, path, fromFile } = loaded;
  const mode = policy.allowWrites ? "WRITE-ENABLED" : "READ-ONLY";
  console.error("");
  console.error("=== bake mcp ===");
  console.error(`Mode:     ${mode}`);
  console.error(
    `Policy:   ${fromFile && path ? path : "(none — built-in read-only defaults)"}`,
  );
  console.error(`allowWrites:            ${policy.allowWrites}`);
  console.error(
    `allowedPrograms:        ${
      policy.allowedPrograms === "any"
        ? "any"
        : JSON.stringify(policy.allowedPrograms)
    }`,
  );
  console.error(`maxDeploysPerSession:   ${policy.maxDeploysPerSession}`);
  console.error(`requireConfirmation:    ${policy.requireConfirmation}`);
  if (!policy.allowWrites) {
    console.error(
      "Write tools (bake_deploy, bake_rollback, bake_confirm_action) are NOT registered.",
    );
  } else if (policy.requireConfirmation) {
    console.error(
      "Write tools require bake_confirm_action with a token (no single-call unsupervised deploy).",
    );
  }
  console.error("stdout is the MCP protocol channel — this summary is on stderr.");
  console.error("================");
  console.error("");
}

export async function startBakeMcpServer(
  loaded: LoadedMcpPolicy,
  cwd = process.cwd(),
): Promise<void> {
  printMcpStartupSummary(loaded);
  // Suppress decorative CLI banner noise on the MCP stdio channel.
  process.env.BAKE_CI = "true";
  const server = createBakeMcpServer({ cwd, loaded });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  auditLog(
    `server connected (${loaded.policy.allowWrites ? "write-enabled" : "read-only"})`,
  );
}
