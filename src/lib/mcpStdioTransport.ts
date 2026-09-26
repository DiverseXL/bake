/**
 * Tolerant stdio transport for `bake mcp`.
 *
 * The MCP stdio spec frames messages as newline-delimited JSON (one JSON-RPC
 * object per line). The SDK's `StdioServerTransport` implements exactly that
 * — and nothing else.
 *
 * Some real MCP clients in the wild (notably the xAI Grok CLI, whose binary
 * literally contains a `Content-Length: Expected` parser) instead use
 * LSP-style framing: a `Content-Length: N\r\n\r\n` header followed by N bytes
 * of JSON. Against a spec-only server those clients hang forever at
 * handshake, which looks like "the agent can't detect bake".
 *
 * This transport sniffs the *first* message off stdin and speaks whichever
 * framing the client used, for input and output. Conformant newline clients
 * are completely unaffected. No external bridge process is required.
 *
 * Do NOT replace this with a plain `StdioServerTransport` "for simplicity" —
 * that silently re-breaks every LSP-framed client (see AGENTS.md §10).
 */
import { deserializeMessage, ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MessageExtraInfo, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

type Framing = "unknown" | "newline" | "lsp";

const CONTENT_LENGTH_RE = /content-length:\s*(\d+)/i;

export class TolerantStdioServerTransport implements Transport {
  private _stdin: NodeJS.ReadableStream;
  private _stdout: NodeJS.WritableStream;
  private _started = false;
  private _framing: Framing = "unknown";
  private _buffer: Buffer = Buffer.alloc(0);
  // Reused for the newline-framing path so we inherit the SDK's exact
  // message parsing (and its max-buffer protection).
  private _readBuffer = new ReadBuffer();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;

  constructor(
    stdin: NodeJS.ReadableStream = process.stdin,
    stdout: NodeJS.WritableStream = process.stdout,
  ) {
    this._stdin = stdin;
    this._stdout = stdout;
  }

  private _ondata = (chunk: Buffer | string): void => {
    try {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this._buffer = this._buffer.length ? Buffer.concat([this._buffer, buf]) : buf;
      this._processBuffer();
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      void this.close();
    }
  };

  private _onerror = (error: Error): void => {
    this.onerror?.(error);
  };

  /** Decide newline vs LSP framing from the first non-whitespace byte. */
  private _detectFraming(): void {
    if (this._framing !== "unknown") return;
    let i = 0;
    while (i < this._buffer.length) {
      const b = this._buffer[i];
      // Skip leading whitespace / blank lines.
      if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) {
        i++;
        continue;
      }
      // Every valid newline-framed message starts with '{'. Anything else
      // (e.g. "Content-Length:") means the client is header-framed.
      this._framing = b === 0x7b ? "newline" : "lsp";
      if (this._framing === "lsp" && i > 0) {
        // Drop the leading blank bytes so header parsing starts cleanly.
        this._buffer = this._buffer.subarray(i);
      }
      return;
    }
  }

  private _processBuffer(): void {
    this._detectFraming();
    if (this._framing === "unknown") return;

    if (this._framing === "newline") {
      this._readBuffer.append(this._buffer);
      this._buffer = Buffer.alloc(0);
      while (true) {
        const message = this._readBuffer.readMessage();
        if (message === null) break;
        this.onmessage?.(message);
      }
      return;
    }

    // LSP framing: Content-Length: N\r\n\r\n<N bytes>
    while (true) {
      const sep = this._buffer.indexOf("\r\n\r\n");
      const sepAlt = sep === -1 ? this._buffer.indexOf("\n\n") : -1;
      const headerEnd = sep !== -1 ? sep : sepAlt;
      if (headerEnd === -1) return;

      const headerText = this._buffer.subarray(0, headerEnd).toString("utf8");
      const match = CONTENT_LENGTH_RE.exec(headerText);
      if (!match) {
        throw new Error("LSP-framed message is missing a Content-Length header");
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + (sep !== -1 ? 4 : 2);
      if (this._buffer.length < bodyStart + length) return; // wait for more bytes

      const body = this._buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this._buffer = this._buffer.subarray(bodyStart + length);
      this.onmessage?.(deserializeMessage(body));
    }
  }

  async start(): Promise<void> {
    if (this._started) {
      throw new Error(
        "TolerantStdioServerTransport already started! If using Server class, note that connect() calls start() automatically.",
      );
    }
    this._started = true;
    this._stdin.on("data", this._ondata);
    this._stdin.on("error", this._onerror);
  }

  async close(): Promise<void> {
    this._stdin.off("data", this._ondata);
    this._stdin.off("error", this._onerror);
    const remaining = (
      this._stdin as NodeJS.ReadableStream & { listenerCount?: (e: string) => number }
    ).listenerCount?.("data");
    if (remaining === 0) {
      (this._stdin as NodeJS.ReadStream).pause?.();
    }
    this._readBuffer.clear();
    this._buffer = Buffer.alloc(0);
    this.onclose?.();
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const body = JSON.stringify(message);
    // LSP clients must get LSP-framed responses back. If framing is somehow
    // still unknown (no request received yet), default to the spec framing.
    const framed =
      this._framing === "lsp"
        ? `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`
        : `${body}\n`;

    return new Promise((resolve) => {
      if (this._stdout.write(framed)) {
        resolve();
      } else {
        this._stdout.once("drain", resolve);
      }
    });
  }
}
