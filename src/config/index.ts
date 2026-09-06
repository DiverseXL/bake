import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { z } from "zod";
import {
  globalConfigSchema,
  projectConfigSchema,
  mergedConfigSchema,
  type MergedConfig,
} from "./types.js";
import chalk from "chalk";

const GLOBAL_CONFIG_DIR = join(homedir(), ".bake");
const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "config.json");
const PROJECT_CONFIG_NAME = "bake.config.json";

function safeReadJson(path: string, label: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : `Unable to read ${label}`;
    throw new Error(`Malformed ${label} at ${path}: ${message}`);
  }
}

export async function loadConfigs(): Promise<MergedConfig> {
  // In this skeleton, loading is synchronous; kept async for future expansion.
  const cwd = process.cwd();

  const globalRaw = safeReadJson(GLOBAL_CONFIG_PATH, "global config");
  const projectRaw = safeReadJson(join(cwd, PROJECT_CONFIG_NAME), "project config");

  // Validate each file independently so errors are clear.
  let globalConfig = globalRaw ? globalConfigSchema.parse(globalRaw) : globalConfigSchema.parse({});
  let projectConfig = projectRaw ? projectConfigSchema.parse(projectRaw) : projectConfigSchema.parse({});

  // Merge: project overrides global where provided.
  const merged = mergedConfigSchema.parse({ ...globalConfig, ...projectConfig });

  return merged;
}

export function getGlobalConfigPath(): string {
  return GLOBAL_CONFIG_PATH;
}

export function getGlobalConfigDir(): string {
  return GLOBAL_CONFIG_DIR;
}

export function ensureGlobalConfigDir(): void {
  if (!existsSync(GLOBAL_CONFIG_DIR)) {
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  }
}

export function readGlobalConfig(): MergedConfig | null {
  if (!existsSync(GLOBAL_CONFIG_PATH)) return null;
  try {
    const raw = readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return globalConfigSchema.parse(parsed);
  } catch {
    return null;
  }
}

export function writeGlobalConfig(data: Record<string, unknown>): void {
  ensureGlobalConfigDir();
  const validated = globalConfigSchema.parse(data);
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(validated, null, 2), "utf-8");
}

export function readProjectConfig(): MergedConfig | null {
  const cwd = process.cwd();
  const path = join(cwd, PROJECT_CONFIG_NAME);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return projectConfigSchema.parse(parsed);
  } catch {
    return null;
  }
}

export function writeProjectConfig(data: Record<string, unknown>): void {
  const cwd = process.cwd();
  const path = join(cwd, PROJECT_CONFIG_NAME);
  const validated = projectConfigSchema.parse(data);
  writeFileSync(path, JSON.stringify(validated, null, 2), "utf-8");
}

// Friendly validation helper for reuse in commands that want to show config errors.
export function validateConfigFile(path: string, label: string): MergedConfig {
  const raw = safeReadJson(path, label);
  if (!raw) {
    throw new Error(`${label} not found at ${path}`);
  }
  try {
    return mergedConfigSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.errors
        .map((issue) => {
          const pathStr = issue.path.join(".");
          return `  - ${pathStr || "root"}: ${issue.message}`;
        })
        .join("\n");
      throw new Error(
        chalk.red(`\n${label} is invalid:\n${issues}\n`)
      );
    }
    throw err as Error;
  }
}
