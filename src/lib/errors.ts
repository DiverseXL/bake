import chalk from "chalk";

// ---------------------------------------------------------------------------
// Themed headline layer — cookie-themed garnishes for friendly errors.
//
// Each entry maps a substring to look for in the error message to a short,
// goofy headline that appears ABOVE the real, actionable message. The
// headline is decorative only — the actual error text is never modified.
//
// --ci and --json modes suppress headlines entirely (see formatUserError).
// ---------------------------------------------------------------------------

// Each entry is [...keywords, headline] — all keywords must appear in the
// message (case-insensitive) for the headline to apply. The headline is
// always the last element.
const THEMED_HEADLINES: string[][] = [
  ["No Anchor.toml found", "No dough here"],
  ["No local wallet found", "Empty cookie jar"],
  ["Keypair file", "Crumbling keypair"],
  ["Failed to load wallet", "Empty cookie jar"],
  ["No program ID found", "No recipe ID"],
  ["No program ID given", "No recipe ID"],
  ["No Recipe Book entries", "Recipe book's empty"],
  ["does not exist", "Recipe Book has entries", "No recipe there"],
  ["only one deploy exists", "Nothing to roll back to"],
  ["working tree has uncommitted changes", "Batter's still out"],
  ["working tree is dirty", "Batter's still out"],
  ["no longer exists in local git history", "That recipe's missing"],
  ["requires WSL", "No oven installed"],
  ["cookie-mcp requires Node", "Oven's too old"],
  ["corrupted", "This config got burnt"],
  ["Malformed", "This config got burnt"],
  ["Unknown cluster", "Wrong oven"],
  ["anchor init failed", "Dough didn't rise"],
  ["already exists here", "Kitchen's already set up"],
  ["Build completed but", "Half-baked build"],
  ["Build failed", "Dough collapsed"],
  ["timed out", "Oven's not responding"],
  ["unreachable", "Can't find the oven"],
  ["ENOENT", "Missing ingredients"],
  ["Deploy failed", "Batch burned"],
  ["Rollback failed", "Batch burned"],
  ["MCP policy", "Burnt policy"],
  ["recipe book already exists", "Recipe book's taken"],
  ["recipe book does not exist", "No recipe book"],
  ["NOT", "authorized", "Not the head chef"],
];

// ---------------------------------------------------------------------------
// ThemedError — for callers that want to explicitly attach a headline.
// ---------------------------------------------------------------------------

export class ThemedError extends Error {
  readonly headline: string;
  constructor(headline: string, message: string) {
    super(message);
    this.name = "ThemedError";
    this.headline = headline;
  }
}

// ---------------------------------------------------------------------------
// Core formatting
// ---------------------------------------------------------------------------

function isSilentMode(): boolean {
  return process.env.BAKE_CI === "true" || process.env.BAKE_JSON === "true";
}

/**
 * Match a message against the themed headline table. Returns the headline
 * if a match is found, or null if no theme applies.
 */
function lookupHeadline(message: string): string | null {
  const lower = message.toLowerCase();
  for (const entry of THEMED_HEADLINES) {
    // Each entry is an array: [...substrings, headline]
    // The last element is always the headline; all preceding are substrings
    // that must ALL appear in the message (case-insensitive).
    const headline = entry[entry.length - 1];
    const keywords = entry.slice(0, -1) as string[];
    if (keywords.every((kw) => lower.includes(kw.toLowerCase()))) {
      return headline;
    }
  }
  return null;
}

/**
 * Format a user-facing error message.
 *
 * In human mode: if a themed headline matches (and --ci/--json is off),
 * prepend `🍪 <headline>\n     ` before the real message.
 * In --ci/--json mode: return the raw message unchanged.
 */
export function formatUserError(message: string): string {
  if (isSilentMode()) {
    return chalk.red(`\nError: ${message}\n`);
  }

  // If the caller explicitly provided a headline via ThemedError, use it.
  // Otherwise, auto-detect from the message content.
  // (ThemedError is handled at the call site before reaching here,
  //  so this only handles string messages.)

  const headline = lookupHeadline(message);
  if (headline) {
    return chalk.red(`\n🍪 ${chalk.bold(headline)}\n     ${message}\n`);
  }
  return chalk.red(`\nError: ${message}\n`);
}

/**
 * Exit with a formatted error. This is the primary user-facing error path.
 *
 * In --ci/--json mode: only the raw message is printed (no themed headline).
 * In human mode: a themed cookie headline may appear above the message.
 */
export function fail(message: string): never {
  console.error(formatUserError(message));
  process.exit(1);
}

/**
 * Convenience wrapper: fail with an explicit themed headline.
 * Use when the auto-detect keywords don't cleanly match, or when the
 * caller wants to be explicit about the headline.
 */
export function themedFail(headline: string, message: string): never {
  if (isSilentMode()) {
    console.error(chalk.red(`\nError: ${message}\n`));
  } else {
    console.error(chalk.red(`\n🍪 ${chalk.bold(headline)}\n     ${message}\n`));
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// BakeError — preserved for backward compatibility with toolchain.ts etc.
// These errors bubble up through catch blocks and get formatted by the
// command that catches them, so no themed headline is added at this layer.
// ---------------------------------------------------------------------------

export class BakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BakeError";
  }
}
