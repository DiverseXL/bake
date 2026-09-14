/**
 * `bake audit` — static analysis for Anchor programs.
 *
 * This command is a thin WRAPPER around Radar (https://github.com/auditware/radar).
 * bake implements no security heuristics of its own; every finding comes from
 * Radar and is labelled as such. See src/lib/radarAudit.ts for the integration
 * details and the confirmed Radar CLI contract.
 *
 * Exit codes mirror Radar's own convention so the command is usable as a CI gate:
 *   0 — no critical/high findings
 *   1 — one or more critical/high findings
 *   2 — operational error (radar not installed, Docker unavailable, scan failed)
 */
import { Command } from "commander";
import chalk from "chalk";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { resolveAnchorProjectRoot } from "../lib/anchorProject.js";
import { fail } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import {
  RadarNotInstalledError,
  RADAR_HOMEPAGE,
  groupFindingsBySeverity,
  runRadarAudit,
  summarizeFindings,
  type RadarAuditResult,
  type RadarSeverity,
} from "../lib/radarAudit.js";

const EXIT_FINDINGS = 1;
const EXIT_OPERATIONAL = 2;
const MAX_LOCATIONS_PER_FINDING = 10;

function isJsonMode(): boolean {
  return process.env.BAKE_JSON === "true";
}

function isCiMode(): boolean {
  return process.env.BAKE_CI === "true";
}

/** Apply chalk styling only when not in --ci (color-free) mode. */
function tint(fn: (text: string) => string, text: string): string {
  return isCiMode() ? text : fn(text);
}

function severityTint(
  severity: RadarSeverity | "other",
  text: string,
): string {
  if (isCiMode()) return text;
  switch (severity) {
    case "critical":
      return chalk.bgRed.white(text);
    case "high":
      return chalk.red(text);
    case "medium":
      return chalk.yellow(text);
    case "low":
      return chalk.dim(text);
    default:
      return chalk.gray(text);
  }
}

/** Resolve the directory to scan: an explicit path, or the Anchor project root. */
function resolveTarget(pathArg?: string): string {
  if (pathArg) {
    const target = resolve(pathArg);
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      fail(`Path not found or not a directory: ${pathArg}`);
    }
    return target;
  }

  const root = resolveAnchorProjectRoot();
  if (!root) {
    fail(
      "No Anchor.toml found — run `bake audit` from your program's root directory, " +
        "or pass a path to scan.",
    );
  }
  return root;
}

function printNotInstalled(err: RadarNotInstalledError): never {
  if (isJsonMode()) {
    console.log(
      JSON.stringify(
        { tool: "radar", installed: false, error: err.message },
        null,
        2,
      ),
    );
  } else {
    logger.error(`\n${err.message}\n`);
  }
  process.exit(EXIT_OPERATIONAL);
}

function printOperationalError(result: RadarAuditResult): never {
  if (isJsonMode()) {
    console.log(
      JSON.stringify(
        {
          tool: "radar",
          target: result.targetPath,
          error: "radar exited with an operational error (exit 2)",
          findings: result.findings,
          stderr: result.stderr,
          raw: result.stdout,
        },
        null,
        2,
      ),
    );
  } else {
    logger.error(
      "\nRadar could not complete the scan (exit 2) — this indicates a parse/scan " +
        "failure or an infrastructure problem, not a security finding.",
    );
    if (result.stdout.trim()) console.error(result.stdout.trim());
    if (result.stderr.trim()) console.error(result.stderr.trim());
  }
  process.exit(EXIT_OPERATIONAL);
}

function printHumanReport(result: RadarAuditResult): void {
  const totalFindings =
    result.counts.critical +
    result.counts.high +
    result.counts.medium +
    result.counts.low;

  if (totalFindings === 0) {
    if (result.exitCode === EXIT_FINDINGS) {
      // Radar gated the scan but we couldn't parse its structured report.
      // Surface its raw output rather than claiming a clean result.
      logger.warn(
        "\n  Radar reported findings at or above HIGH severity, but its report " +
          "could not be parsed. Raw output:\n",
      );
      if (result.stdout.trim()) console.error(result.stdout.trim());
      return;
    }
    logger.success(`\n  No findings — powered by Radar\n`);
    return;
  }

  for (const group of groupFindingsBySeverity(result.findings)) {
    const heading = severityTint(
      group.severity,
      `${group.severity.toUpperCase()} (${group.findings.length})`,
    );
    console.log(`\n  ${heading}`);
    for (const finding of group.findings) {
      console.log(`    ${tint(chalk.bold, finding.name ?? "(unnamed rule)")}`);
      const locations = Array.isArray(finding.locations)
        ? finding.locations
        : [];
      for (const location of locations.slice(0, MAX_LOCATIONS_PER_FINDING)) {
        console.log(`      ${tint(chalk.dim, location)}`);
      }
      if (locations.length > MAX_LOCATIONS_PER_FINDING) {
        console.log(
          `      ${tint(
            chalk.dim,
            `... and ${locations.length - MAX_LOCATIONS_PER_FINDING} more`,
          )}`,
        );
      }
    }
  }

  const summary = `${summarizeFindings(result.counts)} — powered by Radar`;
  if (result.gatingCount > 0) {
    logger.warn(`\n  ${summary}\n`);
  } else {
    logger.info(`\n  ${summary}\n`);
  }
}

async function runAudit(pathArg?: string): Promise<void> {
  const target = resolveTarget(pathArg);

  if (!isJsonMode()) {
    logger.info(
      `\n  Static analysis — powered by Radar (${tint(chalk.dim, RADAR_HOMEPAGE)})`,
    );
    logger.info(`  Target: ${target}\n`);
  }

  let result: RadarAuditResult;
  try {
    result = await runRadarAudit({
      targetPath: target,
      onProgress: isJsonMode() || isCiMode() ? undefined : (msg) => logger.info(`  ${msg}`),
    });
  } catch (err) {
    if (err instanceof RadarNotInstalledError) printNotInstalled(err);
    if (isJsonMode()) {
      console.log(
        JSON.stringify(
          {
            tool: "radar",
            target,
            error: err instanceof Error ? err.message : String(err),
          },
          null,
          2,
        ),
      );
    } else {
      logger.error(
        `\nAudit could not run: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    process.exit(EXIT_OPERATIONAL);
  }

  if (result.exitCode === EXIT_OPERATIONAL) printOperationalError(result);

  if (isJsonMode()) {
    console.log(
      JSON.stringify(
        {
          tool: "radar",
          target,
          findings: result.findings,
          summary: { ...result.counts, gating: result.gatingCount },
          radarExitCode: result.exitCode,
          raw: result.stdout,
        },
        null,
        2,
      ),
    );
  } else {
    printHumanReport(result);
  }

  // Gate on parsed critical/high findings, and trust radar's own exit code as a
  // backstop in case its report couldn't be parsed.
  const gating = result.gatingCount > 0 || result.exitCode === EXIT_FINDINGS;
  process.exit(gating ? EXIT_FINDINGS : 0);
}

export const auditCommand = new Command("audit")
  .description(
    "Static analysis for Anchor programs (wraps Radar — not bake's own analysis)",
  )
  .argument(
    "[path]",
    "Program directory to scan (default: the current Anchor project)",
  )
  .option("--json", "output results as JSON")
  .option("--ci", "disable spinners/colors, force JSON-safe output")
  .action(
    async (pathArg: string | undefined, opts: { json?: boolean; ci?: boolean }) => {
      if (opts.json) process.env.BAKE_JSON = "true";
      if (opts.ci) process.env.BAKE_CI = "true";
      await runAudit(pathArg);
    },
  );
