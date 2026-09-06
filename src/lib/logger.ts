import chalk from "chalk";
import picocolors from "picocolors";

type ColorFn = (text: string) => string;

function isCi(): boolean {
  return process.env.BAKE_CI === "true";
}

function isJson(): boolean {
  return process.env.BAKE_JSON === "true";
}

// In CI mode we intentionally avoid chalk (which can add ANSI codes) and
// prefer picocolors which is lighter, but for true JSON output we may want
// plain strings. This helper keeps output readable in terminals and safe for
// CI/JSON modes.
export const logger = {
  info(text: string): void {
    if (isJson()) {
      // In JSON mode we still log human-readable strings to stderr for now;
      // structured output should be emitted via dedicated JSON pathways.
      console.error(`[info] ${text}`);
      return;
    }
    console.log(picocolors.cyan(text));
  },

  success(text: string): void {
    if (isCi()) {
      console.log(`[success] ${text}`);
      return;
    }
    console.log(chalk.green(text));
  },

  warn(text: string): void {
    if (isCi()) {
      console.warn(`[warn] ${text}`);
      return;
    }
    console.warn(chalk.yellow(text));
  },

  error(text: string): void {
    if (isCi()) {
      console.error(`[error] ${text}`);
      return;
    }
    console.error(chalk.red(text));
  },

  debug(text: string): void {
    if (isCi()) {
      console.log(`[debug] ${text}`);
      return;
    }
    console.log(chalk.gray(text));
  },

  // Plain text escape hatch for JSON-safe messages
  plain(text: string): void {
    console.log(text);
  },
};
