import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Remote build configuration
// ---------------------------------------------------------------------------

const BAKE_BUILD_SERVER_URL = process.env.BAKE_BUILD_SERVER_URL;

export function getBuildServerUrl(): string | null {
  return BAKE_BUILD_SERVER_URL || null;
}

// ---------------------------------------------------------------------------
// Create a tarball of the Anchor project
// ---------------------------------------------------------------------------

async function createProjectTarball(projectDir: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", [
      "-czf", destPath,
      "--exclude=target",
      "--exclude=.anchor",
      "--exclude=node_modules",
      "--exclude=.git",
      "--exclude=test-ledger",
      "-C", projectDir,
      ".",
    ], { windowsHide: true });

    let stderr = "";
    tar.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    tar.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`tar failed (exit ${code}): ${stderr}`));
      } else {
        resolve();
      }
    });

    tar.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// POST tarball to build server, receive zip response
// ---------------------------------------------------------------------------

interface RemoteBuildResult {
  success: boolean;
  soBuffer?: Buffer;
  idlBuffer?: Buffer;
  buildOutput?: { stdout: string; stderr: string };
  error?: string;
}

function postTarball(
  serverUrl: string,
  tarballPath: string,
): Promise<RemoteBuildResult> {
  const boundary = `----BakeOven${randomUUID()}`;
  const fileData = readFileSync(tarballPath);
  const fileName = "project.tar.gz";

  // Build multipart body
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="tarball"; filename="${fileName}"\r\n` +
    `Content-Type: application/gzip\r\n\r\n`,
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([preamble, fileData, epilogue]);

  const url = new URL("/build", serverUrl);
  const isHttps = url.protocol === "https:";
  const httpModule = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = httpModule.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: "/build",
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
        timeout: 30 * 60 * 1000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const responseBuffer = Buffer.concat(chunks);

          if (res.statusCode === 200) {
            resolve(parseBuildZip(responseBuffer));
          } else {
            try {
              const errorBody = JSON.parse(responseBuffer.toString());
              resolve({
                success: false,
                error: errorBody.error || "Build failed",
                buildOutput: {
                  stdout: errorBody.stdout || "",
                  stderr: errorBody.stderr || "",
                },
              });
            } catch {
              resolve({
                success: false,
                error: `Build server returned ${res.statusCode}: ${responseBuffer.toString().slice(0, 500)}`,
              });
            }
          }
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Build server timed out after 30 minutes"));
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Parse zip response (extract .so and IDL via unzip command)
// ---------------------------------------------------------------------------

async function parseBuildZip(zipBuffer: Buffer): Promise<RemoteBuildResult> {
  const tmpZip = join("/tmp", `bakeoven-result-${randomUUID()}.zip`);
  const tmpExtract = join("/tmp", `bakeoven-extract-${randomUUID()}`);

  try {
    mkdirSync(tmpExtract, { recursive: true });
    writeFileSync(tmpZip, zipBuffer);

    // Extract with unzip
    await new Promise<void>((resolve, reject) => {
      const unzip = spawn("unzip", ["-o", tmpZip, "-d", tmpExtract], { windowsHide: true });
      let stderr = "";
      unzip.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
      unzip.on("close", (code) => {
        if (code !== 0) reject(new Error(`unzip failed: ${stderr}`));
        else resolve();
      });
      unzip.on("error", reject);
    });

    const soPath = join(tmpExtract, "program.so");
    const idlPath = join(tmpExtract, "idl.json");
    const outputPath = join(tmpExtract, "build-output.json");

    const result: RemoteBuildResult = { success: true };

    if (existsSync(soPath)) {
      result.soBuffer = readFileSync(soPath);
    }
    if (existsSync(idlPath)) {
      result.idlBuffer = readFileSync(idlPath);
    }
    if (existsSync(outputPath)) {
      result.buildOutput = JSON.parse(readFileSync(outputPath, "utf8"));
    }

    return result;
  } finally {
    try { rmSync(tmpZip, { force: true }); } catch {}
    try { rmSync(tmpExtract, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main remote build function — called by deployPipeline
// ---------------------------------------------------------------------------

export interface RemoteBuildArtifacts {
  soBuffer: Buffer;
  idlBuffer: Buffer | null;
}

/**
 * Build an Anchor project remotely via the bake build server.
 *
 * @param projectDir  Path to the Anchor project root (contains Anchor.toml)
 * @param serverUrl   Build server URL (from BAKE_BUILD_SERVER_URL env)
 * @returns The compiled .so and optional IDL as Buffers
 */
export async function remoteBuild(
  projectDir: string,
  serverUrl: string,
): Promise<RemoteBuildArtifacts> {
  const tmpTarball = join("/tmp", `bakeoven-upload-${randomUUID()}.tar.gz`);

  try {
    logger.info("Creating project tarball for remote build...");
    await createProjectTarball(projectDir, tmpTarball);

    logger.info(`Sending to build server at ${serverUrl}...`);
    const result = await postTarball(serverUrl, tmpTarball);

    if (!result.success) {
      const errMsg = result.error || "Remote build failed";
      const buildOutput = result.buildOutput
        ? `\n\nBuild output:\nstdout: ${result.buildOutput.stdout}\nstderr: ${result.buildOutput.stderr}`
        : "";
      throw new Error(`${errMsg}${buildOutput}`);
    }

    if (!result.soBuffer) {
      throw new Error("Remote build succeeded but no .so file was returned");
    }

    return {
      soBuffer: result.soBuffer,
      idlBuffer: result.idlBuffer || null,
    };
  } finally {
    try { rmSync(tmpTarball, { force: true }); } catch {}
  }
}
