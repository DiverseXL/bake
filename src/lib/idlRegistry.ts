/**
 * Local IDL registry — maps program IDs to their Anchor IDL definitions.
 *
 * Starting with just Recipe Book. Designed to be extended: add your program's
 * IDL to the REGISTRY map, or use `loadIdlFromFile()` at runtime for ad-hoc
 * decoding of arbitrary programs.
 */
import { readFileSync } from "node:fs";
import { BorshInstructionCoder, BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import recipeBookIdl from "../idl/recipe_book.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Static registry
// ---------------------------------------------------------------------------

type RecipeBookIdl = Idl & typeof recipeBookIdl;

const REGISTRY = new Map<string, Idl>([
  [recipeBookIdl.address, recipeBookIdl as RecipeBookIdl],
]);

/**
 * Look up a known IDL by program address.
 * Returns null if the program is not in the registry.
 */
export function getIdlForProgram(programId: PublicKey): Idl | null {
  return REGISTRY.get(programId.toBase58()) ?? null;
}

/**
 * Register an IDL at runtime (e.g. from `--idl <path>`).
 */
export function registerIdl(programId: string, idl: Idl): void {
  REGISTRY.set(programId, idl);
}

/**
 * Load an IDL from a JSON file path and register it.
 * Returns the parsed IDL for immediate use.
 */
export function loadIdlFromFile(filePath: string): Idl {
  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`IDL file at ${filePath} must be a JSON object`);
  }
  const idl = raw as Idl;
  if (idl.address) {
    registerIdl(idl.address, idl);
  }
  return idl;
}

// ---------------------------------------------------------------------------
// Decoder factories — thin wrappers around Anchor's Borsh coders
// ---------------------------------------------------------------------------

export interface DecodedInstruction {
  name: string;
  args: Record<string, unknown>;
  accounts: { name?: string; pubkey: string; isSigner: boolean; isWritable: boolean }[];
}

export interface DecodedAccount {
  type: string;
  fields: Record<string, unknown>;
}

/**
 * Decode instruction data against a known IDL.
 * Returns null if the data doesn't match any instruction in the IDL.
 */
export function decodeInstruction(
  idl: Idl,
  dataHex: string,
  accountMetas?: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
): DecodedInstruction | null {
  const coder = new BorshInstructionCoder(idl);
  const buffer = Buffer.from(dataHex, "hex");
  const decoded = coder.decode(buffer);
  if (!decoded) return null;

  const accountMetasArg = accountMetas ?? [];
  const formatted = coder.format(
    decoded,
    accountMetasArg.map((m) => ({
      pubkey: m.pubkey,
      isSigner: m.isSigner,
      isWritable: m.isWritable,
    })),
  );

  const accounts = formatted
    ? formatted.accounts.map((a) => ({
        name: a.name,
        pubkey: a.pubkey.toBase58(),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      }))
    : [];

  return {
    name: decoded.name,
    args: decoded.data as Record<string, unknown>,
    accounts,
  };
}

/**
 * Decode account data against a known IDL.
 * Uses discriminator matching to auto-detect the account type.
 * Returns null if the data doesn't match any known account type.
 */
export function decodeAccount(
  idl: Idl,
  data: Buffer,
): DecodedAccount | null {
  const coder = new BorshAccountsCoder(idl);
  try {
    const decoded = coder.decodeAny(data);
    // Find the account name by matching discriminator
    for (const acct of (idl as { accounts?: { name: string; discriminator: number[] }[] }).accounts ?? []) {
      const disc = Buffer.from(acct.discriminator);
      if (data.subarray(0, 8).equals(disc)) {
        return { type: acct.name, fields: decoded as Record<string, unknown> };
      }
    }
    // Discriminator matched (decodeAny succeeded) but name not found in IDL
    return { type: "unknown", fields: decoded as Record<string, unknown> };
  } catch {
    return null;
  }
}
