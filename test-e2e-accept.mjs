// E2E test 1: deploy with accept, separate stderr capture.
import { Readable } from "node:stream";

Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
const fakeStdin = Readable.from(Buffer.from("y\ny\n"));
Object.defineProperty(process, "stdin", { value: fakeStdin, writable: true, configurable: true });

process.chdir("C:\\Users\\MY PC\\Documents\\bake\\anchor");

// Intercept stderr to make wallet prompt visible
const origStderrWrite = process.stderr.write.bind(process.stderr);
let walletPromptSeen = false;
process.stderr.write = function(chunk, ...args) {
  const s = typeof chunk === "string" ? chunk : chunk.toString();
  if (s.includes("No wallet found")) walletPromptSeen = true;
  return origStderrWrite(chunk, ...args);
};

const { deployCommand } = await import("./dist/commands/deploy.js");
console.log("--- E2E TEST 1: accept wallet prompt ---");
try {
  await deployCommand.parseAsync([process.argv[0], "deploy"], { from: "user" });
} catch (e) {
  console.log("Deploy exited:", e?.message || e);
}
console.log("Wallet prompt seen:", walletPromptSeen);

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
console.log("Wallet exists:", existsSync(join(homedir(), ".bake", "keypair.json")));
