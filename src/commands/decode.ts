import { Command } from "commander";
import chalk from "chalk";
import { PublicKey, type MessageAddressTableLookup } from "@solana/web3.js";
import { fail } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { getConnection } from "../lib/connection.js";
import {
  getIdlForProgram,
  loadIdlFromFile,
  decodeInstruction,
  decodeAccount,
  type DecodedInstruction,
  type DecodedAccount,
} from "../lib/idlRegistry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isJsonMode(): boolean {
  return process.env.BAKE_JSON === "true";
}

function isCiMode(): boolean {
  return process.env.BAKE_CI === "true";
}

function shortCommit(commit: string): string {
  return commit.length > 8 ? commit.slice(0, 8) : commit;
}

function safePublicKey(value: string): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transaction decoding
// ---------------------------------------------------------------------------

interface DecodedTxInstruction {
  programId: string;
  programName: string | null;
  decoded: boolean;
  name?: string;
  args?: Record<string, unknown>;
  accounts?: { name?: string; pubkey: string; isSigner: boolean; isWritable: boolean }[];
  raw?: string;
}

interface DecodeTxResult {
  signature: string;
  slot: number | null;
  blockTime: number | null;
  success: boolean;
  instructions: DecodedTxInstruction[];
  logs: string[];
}

async function decodeTransaction(
  signature: string,
): Promise<DecodeTxResult> {
  const connection = getConnection();

  let tx;
  try {
    tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Invalid param")) {
      fail(
        `Invalid transaction signature: ${signature}\n` +
          "A Solana transaction signature is a base58-encoded string (44 characters).",
      );
    }
    fail(`Failed to fetch transaction: ${msg}`);
  }

  if (!tx) {
    fail(
      `Transaction not found: ${signature}\n` +
        "Check that the signature is correct and the transaction is confirmed.",
    );
  }

  const message = tx.transaction.message;
  const meta = tx.meta;

  // Resolve account keys — handle both legacy Message and MessageV0
  const isV0 = message.version === 0;
  const staticKeys: PublicKey[] = isV0
    ? (message as import("@solana/web3.js").MessageV0).staticAccountKeys
    : (message as import("@solana/web3.js").Message).accountKeys;
  const lookupTableAccounts = !isV0 ? [] : await Promise.all(
    ((message as import("@solana/web3.js").MessageV0).addressTableLookups ?? []).map(
      async (lookup: import("@solana/web3.js").MessageAddressTableLookup) => {
        const table = await connection.getAddressLookupTable(lookup.accountKey);
        return table?.value?.state.addresses ?? [];
      },
    ),
  ).then((tables) => tables.flat());
  const allKeys = [...staticKeys, ...lookupTableAccounts];

  const instructions: DecodedTxInstruction[] = [];
  const compiledIxs = message.compiledInstructions;

  for (const ix of compiledIxs) {
    const programId = allKeys[ix.programIdIndex]?.toBase58() ?? `index:${ix.programIdIndex}`;
    const dataHex = Buffer.from(ix.data).toString("hex");

    // Resolve account metas for this instruction
    const accountMetas = ix.accountKeyIndexes.map((accountIndex: number) => ({
      pubkey: allKeys[accountIndex] ?? PublicKey.default,
      isSigner: message.isAccountSigner(accountIndex),
      isWritable: message.isAccountWritable(accountIndex),
    }));

    const idl = getIdlForProgram(allKeys[ix.programIdIndex] ?? PublicKey.default);

    if (idl) {
      const decoded = decodeInstruction(idl, dataHex, accountMetas);
      if (decoded) {
        instructions.push({
          programId,
          programName: (idl as { metadata?: { name?: string } }).metadata?.name ?? null,
          decoded: true,
          name: decoded.name,
          args: decoded.args,
          accounts: decoded.accounts,
        });
        continue;
      }
    }

    // Unknown or undecodable instruction
    instructions.push({
      programId,
      programName: null,
      decoded: false,
      raw: dataHex,
    });
  }

  const logs = meta?.logMessages ?? [];
  const success = meta?.err === null || meta?.err === undefined;

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    success,
    instructions,
    logs,
  };
}

// ---------------------------------------------------------------------------
// Account decoding
// ---------------------------------------------------------------------------

interface DecodeAccountResult {
  address: string;
  owner: string;
  lamports: number;
  executable: boolean;
  dataLength: number;
  decoded: boolean;
  type?: string;
  fields?: Record<string, unknown>;
  raw?: string;
}

async function decodeAccountData(address: string): Promise<DecodeAccountResult> {
  const pubkey = safePublicKey(address);
  if (!pubkey) {
    fail(
      `Invalid public key: ${address}\n` +
        "A Solana public key is a base58-encoded string (32-44 characters).",
    );
  }

  const connection = getConnection();
  const accountInfo = await connection.getAccountInfo(pubkey, "confirmed");

  if (!accountInfo) {
    fail(
      `Account not found: ${address}\n` +
        "The account may not exist on the current cluster.",
    );
  }

  const owner = accountInfo.owner.toBase58();
  const data = Buffer.from(accountInfo.data);

  // Try known IDLs
  const idl = getIdlForProgram(accountInfo.owner);
  if (idl) {
    const decoded = decodeAccount(idl, data);
    if (decoded) {
      return {
        address,
        owner,
        lamports: accountInfo.lamports,
        executable: accountInfo.executable,
        dataLength: data.length,
        decoded: true,
        type: decoded.type,
        fields: decoded.fields,
      };
    }
  }

  // Unknown account type — show raw hex
  const maxHexLen = 128;
  const hexPreview =
    data.length <= maxHexLen
      ? data.toString("hex")
      : data.subarray(0, maxHexLen).toString("hex") + "...";

  return {
    address,
    owner,
    lamports: accountInfo.lamports,
    executable: accountInfo.executable,
    dataLength: data.length,
    decoded: false,
    raw: hexPreview,
  };
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

function printTransactionResult(result: DecodeTxResult): void {
  console.log(chalk.bold(`\nbake decode — transaction ${shortCommit(result.signature)}`));
  console.log(`Signature: ${result.signature}`);
  if (result.slot != null) console.log(`Slot:      ${result.slot}`);
  if (result.blockTime != null) {
    console.log(`Time:      ${new Date(result.blockTime * 1000).toISOString()}`);
  }
  console.log(`Status:    ${result.success ? chalk.green("success") : chalk.red("failed")}`);

  console.log(chalk.bold(`\nInstructions (${result.instructions.length}):`));

  for (let i = 0; i < result.instructions.length; i++) {
    const ix = result.instructions[i];
    const label = ix.decoded
      ? `${chalk.cyan(ix.name!)}${ix.programName ? chalk.dim(` (${ix.programName})`) : ""}`
      : chalk.yellow("unknown program");

    console.log(`\n  ${chalk.bold(`#${i}`)} ${label}`);
    console.log(chalk.gray(`    program: ${ix.programId}`));

    if (ix.decoded && ix.args && Object.keys(ix.args).length > 0) {
      console.log(chalk.gray("    args:"));
      for (const [key, value] of Object.entries(ix.args)) {
        const formatted = formatArgValue(key, value);
        console.log(chalk.gray(`      ${key}: ${formatted}`));
      }
    }

    if (ix.accounts && ix.accounts.length > 0) {
      console.log(chalk.gray("    accounts:"));
      for (const acct of ix.accounts) {
        const flags = [
          acct.isSigner ? "signer" : null,
          acct.isWritable ? "writable" : null,
        ]
          .filter(Boolean)
          .join(", ");
        const name = acct.name ? chalk.dim(` (${acct.name})`) : "";
        console.log(
          chalk.gray(
            `      ${acct.pubkey}${name}${flags ? chalk.dim(` [${flags}]`) : ""}`,
          ),
        );
      }
    }

    if (!ix.decoded && ix.raw) {
      console.log(chalk.gray(`    raw data: ${ix.raw}`));
    }
  }

  if (result.logs.length > 0) {
    console.log(chalk.bold("\nLogs:"));
    for (const log of result.logs) {
      const formatted = formatLogLine(log);
      console.log(chalk.gray(`  ${formatted}`));
    }
  }
  console.log("");
}

function formatArgValue(key: string, value: unknown): string {
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === "string") return value;
  // Handle BN (BigNumber) from Anchor — has toNumber() method
  if (typeof value === "object" && value !== null && typeof (value as { toNumber?: () => number }).toNumber === "function") {
    try {
      return String((value as { toNumber: () => number }).toNumber());
    } catch {
      // BigInts or very large numbers may overflow
      return String((value as { toString: () => string }).toString());
    }
  }
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array || (Array.isArray(value) && value.length > 0 && typeof value[0] === "number")) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (key.toLowerCase().includes("hash") && bytes.length === 32) {
      return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    if (bytes.length <= 32) {
      return `bytes(${bytes.length}) ${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    }
    return `bytes(${bytes.length})`;
  }
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatLogLine(line: string): string {
  if (isCiMode() || isJsonMode()) return line;
  return /\b(error|failed)\b/i.test(line) ? chalk.red(line) : line;
}

function printAccountResult(result: DecodeAccountResult): void {
  console.log(chalk.bold(`\nbake decode — account ${shortCommit(result.address)}`));
  console.log(`Address:  ${result.address}`);
  console.log(`Owner:    ${result.owner}`);
  console.log(`Balance:  ${result.lamports} lamports (${(result.lamports / 1e9).toFixed(4)} SOL)`);
  console.log(`Data:     ${result.dataLength} bytes`);
  console.log(`Exec:     ${result.executable}`);

  if (result.decoded) {
    console.log(chalk.bold(`\nType: ${chalk.cyan(result.type!)}`));
    if (result.fields && Object.keys(result.fields).length > 0) {
      console.log(chalk.bold("Fields:"));
      for (const [key, value] of Object.entries(result.fields)) {
        const formatted = formatArgValue(key, value);
        console.log(chalk.gray(`  ${key}: ${formatted}`));
      }
    }
  } else {
    console.log(chalk.yellow("\nUnknown account type (not in IDL registry)"));
    if (result.raw) {
      console.log(chalk.gray(`Raw hex: ${result.raw}`));
    }
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const decodeCommand = new Command("decode")
  .description(
    "Decode a transaction, account data, or program log lines using Anchor IDLs",
  )
  .argument("[signature]", "transaction signature to decode")
  .option("--account <address>", "decode an account's data instead of a transaction")
  .option("--idl <path>", "path to an additional IDL JSON file for decoding")
  .option("--json", "output results as JSON")
  .option("--ci", "disable colors in output")
  .action(
    async (
      signature: string | undefined,
      opts: {
        account?: string;
        idl?: string;
        json?: boolean;
        ci?: boolean;
      },
    ) => {
      if (opts.json) process.env.BAKE_JSON = "true";
      if (opts.ci) process.env.BAKE_CI = "true";

      // Load extra IDL if provided
      if (opts.idl) {
        try {
          loadIdlFromFile(opts.idl);
        } catch (err) {
          fail(
            `Failed to load IDL from ${opts.idl}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      try {
        if (opts.account) {
          // ── Account decode mode ──────────────────────────────────────
          const result = await decodeAccountData(opts.account);
          if (isJsonMode()) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            printAccountResult(result);
          }
        } else if (signature) {
          // ── Transaction decode mode ──────────────────────────────────
          const result = await decodeTransaction(signature);
          if (isJsonMode()) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            printTransactionResult(result);
          }
        } else {
          fail(
            "Provide a transaction signature or use --account <address> to decode an account.",
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isJsonMode()) {
          console.log(JSON.stringify({ error: msg }, null, 2));
        } else {
          fail(msg);
        }
      }
    },
  );
