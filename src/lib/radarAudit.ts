/**
 * Radar integration — `bake audit` is a WRAPPER around Radar, not a scanner.
 *
 * Radar (https://github.com/auditware/radar) is Auditware's static analysis
 * tool for rust/anchor/stylus/solidity smart contracts, recommended by the
 * Solana docs. bake deliberately ships no security heuristics of its own:
 * every finding surfaced here is Radar's, and must be labelled as such.
 *
 * Confirmed interface (verified against the installed tool, not just docs):
 *   - Install: `curl -L .../install-radar.sh | bash`
 *       clones to `$XDG_CONFIG_HOME/.radar` (default `$HOME/.radar`) and
 *       symlinks `/usr/local/bin/radar`. Requires Docker, installed and running.
 *   - Invoke:  `radar -p <path>` (scan is the default command).
 *   - Output:  human-readable lines on stdout (`[ HIGH ] <rule> found at:`),
 *              plus a machine-readable file via `-o <file>.json|.md|.sarif`.
 *   - Exit:    0 clean, 1 findings at/above --fail-on, 2 operational error.
 *
 * We always ask for the JSON report (`-o <tmp>.json`) so findings can be grouped
 * deterministically, and pass `--fail-on high` so Radar's own exit code lines up
 * with bake's gate (critical/high = fail). Radar's JSON report is a top-level
 * array of findings shaped `{ name, severity, locations[], certainty }`.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BakeError } from "./errors.js";
import { runToolchainCommand } from "./toolchain.js";

export const RADAR_HOMEPAGE = "https://github.com/auditware/radar";
export const RADAR_INSTALL_COMMAND =
  "curl -L https://raw.githubusercontent.com/auditware/radar/main/install-radar.sh | bash";

export const RADAR_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type RadarSeverity = (typeof RADAR_SEVERITIES)[number];

/** Severities that gate a deploy / make `bake audit` exit non-zero. */
export const GATING_SEVERITIES: readonly RadarSeverity[] = ["critical", "high"];

export interface RadarFinding {
  name?: string;
  severity?: string;
  locations?: string[];
  certainty?: string;
  [key: string]: unknown;
}

export type SeverityCounts = Record<RadarSeverity, number>;

export interface RadarAuditResult {
  /** Absolute command radar was invoked as (PATH entry or ~/.radar/radar). */
  radarCommand: string;
  /** Radar's own exit code: 0 clean, 1 findings at/above --fail-on, 2 error. */
  exitCode: number;
  findings: RadarFinding[];
  counts: SeverityCounts;
  /** critical + high — the findings bake gates on. */
  gatingCount: number;
  stdout: string;
  stderr: string;
  targetPath: string;
}

/** Thrown when radar is not installed — never auto-installed silently. */
export class RadarNotInstalledError extends BakeError {
  constructor() {
    super(
      "Radar is not installed. `bake audit` is a wrapper around Radar " +
        `(${RADAR_HOMEPAGE}) and ships no scanner of its own.\n` +
        `  Install it with:\n    ${RADAR_INSTALL_COMMAND}\n` +
        "  Radar also needs Docker installed and running.",
    );
    this.name = "RadarNotInstalledError";
  }
}

/**
 * Thrown when radar is installed but cannot run because Docker is unavailable.
 *
 * This matters because radar's shell wrapper exits 1 BOTH for "findings at or
 * above --fail-on" and for its own startup failures (its `check_docker` gives
 * up with `exit 1`). Without distinguishing them, a missing Docker would be
 * reported as a high-severity security finding.
 */
export class RadarDockerUnavailableError extends BakeError {
  constructor(detail: string) {
    super(
      "Radar requires Docker, but Docker is not available to bake.\n" +
        `  ${detail}\n` +
        "  Start Docker (Docker Desktop on Windows/macOS, or the docker daemon " +
        "on Linux) and re-run `bake audit`.",
    );
    this.name = "RadarDockerUnavailableError";
  }
}

/**
 * Signatures that radar's wrapper emits for infrastructure problems rather than
 * findings. Matched case-insensitively against radar's combined output.
 */
const DOCKER_FAILURE_PATTERNS = [
  "docker was not available",
  "please ensure docker is installed and running",
  "failed to start radar containers",
  "cannot connect to the docker daemon",
  "is the docker daemon running",
  "docker: command not found",
  "docker daemon is not running",
  "error during connect",
];

export function emptySeverityCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

/** Normalize a raw severity string, or null if it isn't one we recognise. */
export function normalizeSeverity(value: unknown): RadarSeverity | null {
  const v = String(value ?? "").toLowerCase();
  return (RADAR_SEVERITIES as readonly string[]).includes(v)
    ? (v as RadarSeverity)
    : null;
}

export function countSeverities(findings: RadarFinding[]): SeverityCounts {
  const counts = emptySeverityCounts();
  for (const finding of findings) {
    const severity = normalizeSeverity(finding.severity);
    if (severity) counts[severity]++;
  }
  return counts;
}

export function gatingCountOf(counts: SeverityCounts): number {
  return GATING_SEVERITIES.reduce((sum, s) => sum + counts[s], 0);
}

/**
 * Locate the radar executable, preferring PATH and falling back to the
 * installer's canonical `$HOME/.radar/radar`.
 *
 * The fallback matters because the installer appends its directory to
 * `~/.bashrc`, which non-interactive shells (how bake relays toolchain
 * commands) skip — so `radar` is frequently absent from PATH even when
 * installed. Returns null when neither is found.
 */
async function resolveRadarCommand(cwd: string): Promise<string | null> {
  const script = [
    "if command -v radar >/dev/null 2>&1; then command -v radar;",
    'elif [ -x "${XDG_CONFIG_HOME:-$HOME}/.radar/radar" ];',
    'then echo "${XDG_CONFIG_HOME:-$HOME}/.radar/radar"; fi',
  ].join(" ");

  try {
    const result = await runToolchainCommand("sh", ["-c", script], { cwd });
    const line = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    return line || null;
  } catch {
    return null;
  }
}

/**
 * Pre-start radar's Docker containers so radar's own `docker compose up`
 * is a no-op. This avoids a race condition where radar's cleanup + restart
 * sequence fails on WSL2 Docker Desktop due to health check timing.
 */
async function preStartRadarContainers(cwd: string): Promise<void> {
  const radarDir = join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".radar",
  );
  // Use bash (not sh) for reliable for-loop syntax. Wait up to 120s for API.
  const upScript = `cd "${radarDir}" && docker compose up -d --quiet-pull --no-build 2>/dev/null; i=0; while [ $i -lt 24 ]; do status=$(docker inspect --format="{{.State.Health.Status}}" radar-api 2>/dev/null || echo "missing"); if [ "$status" = "healthy" ]; then exit 0; fi; sleep 5; i=$((i+1)); done; echo "[w] Radar API did not become healthy in time, proceeding anyway"`;

  try {
    await runToolchainCommand("bash", ["-c", upScript], { cwd });
  } catch {
    // Best-effort; radar's own compose_up will handle failures
  }
}

/** Strip ANSI color codes (radar colors its stdout even when piped). */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Parse radar's human-readable stdout into findings (fallback path). */
function parseFindingsFromText(stdout: string): RadarFinding[] {
  const findings: RadarFinding[] = [];
  let current: RadarFinding | null = null;
  const header = /^\[\s*(critical|high|medium|low)\s*\]\s+(.+?)\s+found at\b/i;

  for (const raw of stripAnsi(stdout).split(/\r?\n/)) {
    const line = raw.trim();
    const match = header.exec(line);
    if (match) {
      current = {
        severity: match[1].toLowerCase(),
        name: match[2].trim(),
        locations: [],
      };
      findings.push(current);
      continue;
    }
    const location = /^\*\s+(.+)$/.exec(line);
    if (location && current) {
      current.locations!.push(location[1].trim());
    }
  }

  return findings.filter(
    (f) => (f.locations?.length ?? 0) > 0 || Boolean(f.name),
  );
}

/**
 * Read radar's structured report, falling back to parsing stdout when the
 * report is missing or unparseable (e.g. the scan errored before writing it).
 */
function readFindings(outFile: string, stdout: string): RadarFinding[] {
  try {
    if (existsSync(outFile)) {
      const parsed: unknown = JSON.parse(readFileSync(outFile, "utf-8"));
      if (Array.isArray(parsed)) return parsed as RadarFinding[];
      const nested =
        parsed && typeof parsed === "object"
          ? (parsed as { findings?: unknown }).findings
          : undefined;
      if (Array.isArray(nested)) return nested as RadarFinding[];
    }
  } catch {
    // fall through to text parsing
  }
  return parseFindingsFromText(stdout);
}

/**
 * Run radar against a target directory and return its findings.
 *
 * Throws RadarNotInstalledError when radar cannot be found — bake never
 * auto-installs a security tool behind the user's back.
 */
export async function runRadarAudit(options: {
  targetPath: string;
  cwd?: string;
}): Promise<RadarAuditResult> {
  const targetPath = options.targetPath;
  const cwd = options.cwd ?? targetPath;

  const radarCommand = await resolveRadarCommand(cwd);
  if (!radarCommand) throw new RadarNotInstalledError();

  // Written by the radar container and copied back out to this path.
  const outFile = join(
    tmpdir(),
    `bake-radar-audit-${randomBytes(6).toString("hex")}.json`,
  );

  try {
    // Retry once on Docker infrastructure failures (race condition in
    // radar's compose down + up sequence on WSL2 Docker Desktop).
    const MAX_ATTEMPTS = 2;
    let lastResult: { exitCode: number; stdout: string; stderr: string } | null = null;
    let lastFailurePattern: string | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await runToolchainCommand(
        radarCommand,
        ["-p", targetPath, "-o", outFile, "--fail-on", "high"],
        { cwd },
      );

      const combined = `${result.stdout}\n${result.stderr}`;
      const lowered = combined.toLowerCase();
      const failurePattern = DOCKER_FAILURE_PATTERNS.find((p) =>
        lowered.includes(p),
      );

      if (result.exitCode !== 0 && failurePattern) {
        lastResult = result;
        lastFailurePattern = failurePattern;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
      } else {
        lastResult = result;
        lastFailurePattern = failurePattern;
        break;
      }
    }

    const result = lastResult!;
    const failurePattern = lastFailurePattern;

    // Distinguish radar's infrastructure failures from real findings: its
    // wrapper uses exit code 1 for both.
    if (result.exitCode !== 0 && failurePattern) {
      const detail =
        stripAnsi(`${result.stdout}\n${result.stderr}`)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.toLowerCase().includes(failurePattern)) ??
        failurePattern;
      throw new RadarDockerUnavailableError(detail);
    }

    const findings = readFindings(outFile, result.stdout);
    const counts = countSeverities(findings);

    return {
      radarCommand,
      exitCode: result.exitCode,
      findings,
      counts,
      gatingCount: gatingCountOf(counts),
      stdout: stripAnsi(result.stdout),
      stderr: stripAnsi(result.stderr),
      targetPath,
    };
  } finally {
    try {
      if (existsSync(outFile)) unlinkSync(outFile);
    } catch {
      // Best-effort temp cleanup; the OS temp dir will reap it eventually.
    }
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers (shared by `bake audit` and `deploy --require-audit`)
// ---------------------------------------------------------------------------

/** Human summary, e.g. "3 findings: 1 high, 2 medium". */
export function summarizeFindings(counts: SeverityCounts): string {
  const total = RADAR_SEVERITIES.reduce((sum, s) => sum + counts[s], 0);
  if (total === 0) return "No findings";
  const parts = RADAR_SEVERITIES.filter((s) => counts[s] > 0).map(
    (s) => `${counts[s]} ${s}`,
  );
  return `${total} finding${total === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

/** Group findings by severity, most severe first, unknowns last. */
export function groupFindingsBySeverity(
  findings: RadarFinding[],
): Array<{ severity: RadarSeverity | "other"; findings: RadarFinding[] }> {
  const groups: Array<{
    severity: RadarSeverity | "other";
    findings: RadarFinding[];
  }> = [];
  for (const severity of RADAR_SEVERITIES) {
    const group = findings.filter(
      (f) => normalizeSeverity(f.severity) === severity,
    );
    if (group.length) groups.push({ severity, findings: group });
  }
  const other = findings.filter((f) => normalizeSeverity(f.severity) === null);
  if (other.length) groups.push({ severity: "other", findings: other });
  return groups;
}

/** Plain (uncolored) multi-line listing of findings, grouped by severity. */
export function formatFindingsList(
  findings: RadarFinding[],
  maxLocations = 10,
): string {
  const lines: string[] = [];
  for (const group of groupFindingsBySeverity(findings)) {
    lines.push(`${group.severity.toUpperCase()} (${group.findings.length})`);
    for (const finding of group.findings) {
      lines.push(`  ${finding.name ?? "(unnamed rule)"}`);
      const locations = Array.isArray(finding.locations)
        ? finding.locations
        : [];
      for (const location of locations.slice(0, maxLocations)) {
        lines.push(`    - ${location}`);
      }
      if (locations.length > maxLocations) {
        lines.push(`    ... and ${locations.length - maxLocations} more`);
      }
    }
  }
  return lines.join("\n");
}
