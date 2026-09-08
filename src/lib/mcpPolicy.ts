import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

/**
 * MCP write-policy schema. Without a loaded policy (or with allowWrites:false),
 * write tools are not registered at all — agents must not even see them.
 */
export const mcpPolicySchema = z
  .object({
    allowWrites: z.boolean().default(false),
    allowedPrograms: z
      .union([z.array(z.string()), z.literal("any")])
      .default("any"),
    maxDeploysPerSession: z.number().int().positive().default(5),
    requireConfirmation: z.boolean().default(true),
  })
  .passthrough();

export type McpPolicy = z.infer<typeof mcpPolicySchema>;

export const DEFAULT_MCP_POLICY: McpPolicy = mcpPolicySchema.parse({});

export const DEFAULT_POLICY_RELATIVE_PATH = join(".bake", "mcp-policy.json");

export interface LoadedMcpPolicy {
  /** Resolved absolute path, or null when running on built-in defaults (no file). */
  path: string | null;
  /** True when a policy file was found and loaded. */
  fromFile: boolean;
  policy: McpPolicy;
}

function safeParsePolicyFile(path: string): McpPolicy {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`MCP policy at ${path} must be a JSON object`);
  }
  return mcpPolicySchema.parse(raw);
}

/**
 * Resolve and load MCP policy.
 *
 * - If `policyPath` is given, that file is required (missing = error).
 * - Otherwise look for `.bake/mcp-policy.json` under `cwd`.
 * - If neither exists, return defaults with `allowWrites: false` (read-only).
 */
export function loadMcpPolicy(
  cwd: string,
  policyPath?: string,
): LoadedMcpPolicy {
  if (policyPath) {
    const abs = isAbsolute(policyPath) ? policyPath : resolve(cwd, policyPath);
    if (!existsSync(abs)) {
      throw new Error(`MCP policy file not found: ${abs}`);
    }
    return { path: abs, fromFile: true, policy: safeParsePolicyFile(abs) };
  }

  const defaultPath = resolve(cwd, DEFAULT_POLICY_RELATIVE_PATH);
  if (existsSync(defaultPath)) {
    return {
      path: defaultPath,
      fromFile: true,
      policy: safeParsePolicyFile(defaultPath),
    };
  }

  return { path: null, fromFile: false, policy: { ...DEFAULT_MCP_POLICY } };
}

export function isProgramAllowed(
  policy: McpPolicy,
  programId: string,
): boolean {
  if (policy.allowedPrograms === "any") return true;
  return policy.allowedPrograms.includes(programId);
}
