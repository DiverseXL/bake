import chalk from "chalk";

// Exact cookie shape (bite = missing right border on row 3).
// "bake!" sits on the bite row, vertically centered against the middle.
const COOKIE_LINES = [
  `   .-'''-.`,
  `  /  o  o \\`,
  ` |  o    o`,
  `  \\  o  o /`,
  `   \`-...-'`,
];

const WORDMARK = "bake!";
const WORDMARK_ROW = 2; // 0-based; middle/bite row
const WORDMARK_GAP = "     ";

function shouldPrintBanner(): boolean {
  // Piped/redirected stdout must stay clean of decorative art.
  if (process.stdout.isTTY === false) return false;

  // MCP uses stdout as the protocol channel — never decorate it.
  if (process.argv.includes("mcp")) return false;

  // Same flags the program.preAction hook tracks. Check argv so this
  // can run before commander parses, and env in case those were set first.
  if (process.argv.includes("--ci") || process.argv.includes("--json")) {
    return false;
  }
  if (process.env.BAKE_CI === "true" || process.env.BAKE_JSON === "true") {
    return false;
  }
  return true;
}

function renderBanner(): string {
  const cookie = chalk.hex("#C68E5B").dim;
  const wordmark = chalk.hex("#F4D03F").bold;

  return COOKIE_LINES.map((line, i) => {
    if (i === WORDMARK_ROW) {
      return cookie(line) + WORDMARK_GAP + wordmark(WORDMARK);
    }
    return cookie(line);
  }).join("\n");
}

export function printBanner(): void {
  if (!shouldPrintBanner()) return;
  console.log(renderBanner());
}
