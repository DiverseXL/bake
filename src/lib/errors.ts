import chalk from "chalk";

export function formatUserError(message: string): string {
  return chalk.red(`\nError: ${message}\n`);
}

export function fail(message: string): never {
  console.error(formatUserError(message));
  process.exit(1);
}

export class BakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BakeError";
  }
}
