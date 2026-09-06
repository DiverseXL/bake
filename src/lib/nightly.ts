/**
 * Nightly Connect integration — isolated behind this module so it can be
 * swapped out or removed without touching the default login path.
 *
 * ⚠ Nightly Connect's docs site is deprecated upstream. This integration
 *   is intended for high-stakes confirmations (e.g. a future
 *   `bake deploy --confirm nightly` for production) and NOT for routine
 *   local signing. Keep all Nightly-specific logic here.
 */
import QRCode from "qrcode";
import chalk from "chalk";
import { logger } from "./logger.js";

const NIGHTLY_RELAY_URL = "https://nc2.nightly.app";
const CONNECTION_TIMEOUT_MS = 60_000;

export interface NightlyConnectResult {
  publicKey: string;
  sessionId: string;
}

/**
 * Attempt to establish a Nightly Connect session.
 *
 * 1. Creates an AppSolana session on the relay server.
 * 2. Renders the session URL as a compact terminal QR code.
 * 3. Also prints the raw link for copy-paste.
 * 4. Waits for a wallet to connect (with a 60 s timeout).
 *
 * Returns the connected wallet's public key and session ID.
 * Throws on timeout or connection failure (no stack trace exposed).
 */
export async function connectNightly(): Promise<NightlyConnectResult> {
  // Lazy import — @nightlylabs/nightly-connect-solana uses @solana/web3.js v1
  // types internally, so we isolate the import here to avoid polluting the
  // rest of the codebase.
  const { AppSolana } = await import("@nightlylabs/nightly-connect-solana");

  // AppSolana.build() creates a session on the relay and returns an app
  // instance that listens for wallet connections.
  //
  // The nightly-connect library's WebSocket doesn't surface errors through
  // the promise chain (e.g. DNS failures emit 'error' on the raw WebSocket
  // and the promise hangs forever). We race the build against a short
  // timeout while also capturing uncaught WebSocket errors.
  let app: any;
  {
    const capturedErrors: Error[] = [];
    const onError = (err: Error) => {
      capturedErrors.push(err);
    };
    process.on("uncaughtException", onError);

    try {
      const buildPromise = AppSolana.build({
        appMetadata: {
          name: "bake",
          description: "Cookie Chain developer tool",
          url: "https://github.com/DiverseXL/bake",
        },
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Connection to ${NIGHTLY_RELAY_URL} timed out`));
        }, 15_000);
      });

      // Race: build vs timeout vs captured WebSocket errors
      app = await Promise.race([
        buildPromise,
        timeoutPromise,
        // A promise that rejects as soon as we capture a WebSocket error
        new Promise<never>((_, reject) => {
          const check = setInterval(() => {
            if (capturedErrors.length > 0) {
              clearInterval(check);
              reject(capturedErrors[0]);
            }
          }, 50);
          // Also stop checking if buildPromise settles
          buildPromise.finally(() => clearInterval(check));
        }),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not reach Nightly Connect relay (${NIGHTLY_RELAY_URL}).\n` +
          `  ${msg}\n` +
          `  This may be a network issue or the relay may be offline.`,
      );
    } finally {
      process.removeListener("uncaughtException", onError);
    }
  }

  const sessionId = app.sessionId;
  const deeplinkUrl = `https://connect.nightly.app/solana?sessionId=${sessionId}`;

  // --- QR code + link ------------------------------------------------
  if (process.env.BAKE_JSON !== "true" && process.env.BAKE_CI !== "true") {
    try {
      const qr = await QRCode.toString(deeplinkUrl, {
        type: "terminal",
        small: true,
        margin: 1,
      });
      console.log(qr);
    } catch {
      // If QR rendering fails, fall back to just the link
    }
  }

  logger.info(`Session link (scan or paste):\n  ${chalk.dim(deeplinkUrl)}\n`);

  // --- Wait for connection -------------------------------------------
  const publicKey = await waitForConnection(app);
  return { publicKey, sessionId };
}

/**
 * Wait for a wallet to connect to the session.
 * Resolves with the first connected public key, or rejects on timeout.
 */
function waitForConnection(app: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const isJson = process.env.BAKE_JSON === "true";
    const isCi = process.env.BAKE_CI === "true";

    // If wallet is already connected (restored session), resolve immediately.
    if (app.connectedPublicKeys && app.connectedPublicKeys.length > 0) {
      const key = app.connectedPublicKeys[0];
      const pubkeyStr = typeof key === "string" ? key : key.toString();
      resolve(pubkeyStr);
      return;
    }

    let resolved = false;
    const deadline = Date.now() + CONNECTION_TIMEOUT_MS;

    // Periodic countdown feedback (skipped in --json / --ci mode)
    const feedbackInterval = setInterval(() => {
      if (resolved) return;
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (!isJson && !isCi) {
        process.stdout.write(
          `\r  Waiting for wallet… (${remaining}s left)  `,
        );
      }
      if (remaining <= 0) {
        clearInterval(feedbackInterval);
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(
            new Error(
              "Nightly Connect timed out after 60 seconds. No wallet connected.",
            ),
          );
        }
      }
    }, 1_000);

    function onUserConnected(e: { publicKeys: string[] }) {
      if (resolved) return;
      if (e.publicKeys && e.publicKeys.length > 0) {
        resolved = true;
        clearInterval(feedbackInterval);
        cleanup();
        if (!isJson && !isCi) {
          process.stdout.write("\r" + " ".repeat(60) + "\r");
        }
        resolve(e.publicKeys[0]);
      }
    }

    function onUserDisconnected() {
      if (resolved) return;
      // Wallet disconnected before fully connecting — not fatal, keep waiting
    }

    function onAppDisconnected() {
      if (resolved) return;
      resolved = true;
      clearInterval(feedbackInterval);
      cleanup();
      reject(new Error("Nightly Connect relay disconnected."));
    }

    function cleanup() {
      app.removeListener("userConnected", onUserConnected);
      app.removeListener("userDisconnected", onUserDisconnected);
      app.removeListener("appDisconnected", onAppDisconnected);
    }

    app.on("userConnected", onUserConnected);
    app.on("userDisconnected", onUserDisconnected);
    app.on("appDisconnected", onAppDisconnected);
  });
}
