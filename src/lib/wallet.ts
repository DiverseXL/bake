/**
 * Local keypair loading — shared by `bake login`, `bake deploy`, and any
 * command that needs to sign with the configured wallet.
 *
 * Uses the classic @solana/web3.js v1 `Keypair.fromSecretKey` API so the
 * result can be passed straight into the Recipe Book client.
 */
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { Keypair } from "@solana/web3.js";
import { getGlobalConfigDir, readGlobalConfig } from "../config/index.js";
import { fail } from "./errors.js";


/** Standard Solana CLI keypair location. */
export const SOLANA_CLI_KEYPATH = join(homedir(), ".config", "solana", "id.json");
/** Bake-specific fallback keypair location. */
export const BAKE_KEYPATH = join(getGlobalConfigDir(), "keypair.json");

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Resolve an existing keypair file path, in priority order:
 *   1. walletPath stored in global config
 *   2. ~/.config/solana/id.json  (standard Solana CLI location)
 *   3. ~/.bake/keypair.json      (bake-specific fallback)
 *
 * Returns the resolved absolute path or `null` if none found.
 */
export function resolveWalletPath(): string | null {
  const cfg = readGlobalConfig();
  const candidates = [
    cfg?.walletPath,
    SOLANA_CLI_KEYPATH,
    BAKE_KEYPATH,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const p of candidates) {
    const expanded = expandHome(p);
    const abs = isAbsolute(expanded) ? expanded : resolve(expanded);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/** Absolute path to the local wallet file. Fails if none is configured. */
export function getWalletPath(): string {
  const path = resolveWalletPath();
  if (!path) {
    fail("No local wallet found. Run `bake login` to set one up.");
  }
  return path;
}

/**
 * Load the local keypair from disk via `Keypair.fromSecretKey`.
 * Fails with a friendly error if the file is missing or malformed.
 */
export function loadLocalWallet(): Keypair {
  const path = getWalletPath();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Failed to load wallet at ${path}: ${msg}`);
  }
  if (!Array.isArray(raw) || !raw.every((n) => typeof n === "number")) {
    fail(`Keypair file at ${path} is not a JSON array of numbers.`);
  }
  const bytes = Uint8Array.from(raw as number[]);
  if (bytes.length !== 64) {
    fail(`Keypair file at ${path} is not 64 bytes (got ${bytes.length}).`);
  }
  try {
    return Keypair.fromSecretKey(bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Failed to load wallet at ${path}: ${msg}`);
  }
}
