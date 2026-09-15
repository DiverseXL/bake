/**
 * Lazy singleton client for the official cookie-mcp server.
 *
 * Spawns `cookie-mcp` as an isolated child process with stdio-piped
 * transport (never inherited — bake's own MCP server also uses stdio, and
 * mixing streams would corrupt both protocols).
 *
 * COOKIE_PRIVATE_KEY is NEVER set in the spawn env — this integration is
 * strictly read-only (token info, pool lookups). No wallet/signing capability.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLUSTERS } from "../clusters/index.js";
import { VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CookieTokenInfo {
  mint: string;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  hasLiquidity: boolean;
  isOnLaunchpad: boolean;
  pools: { address: string; type: string; tvlUsd: number }[];
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let clientPromise: Promise<Client> | null = null;
let transport: StdioClientTransport | null = null;

const CONNECT_TIMEOUT_MS = 60_000;
const NODE_MIN_MAJOR = 22;

function auditLog(message: string): void {
  const ts = new Date().toISOString();
  console.error(`[cookie-mcp ${ts}] ${message}`);
}

function getNodeMajorVersion(): number {
  const match = process.version.match(/^v(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

// ---------------------------------------------------------------------------
// Lazy connection
// ---------------------------------------------------------------------------

async function getClient(): Promise<Client> {
  if (clientPromise) return clientPromise;

  const nodeMajor = getNodeMajorVersion();
  if (nodeMajor < NODE_MIN_MAJOR) {
    throw new Error(
      `cookie-mcp requires Node ${NODE_MIN_MAJOR}+, found Node ${process.version}. ` +
        `Upgrade Node or disable bake_check_token_liquidity.`,
    );
  }

  auditLog("spawning cookie-mcp (first call)...");

  const cookieRpcUrl = CLUSTERS.cookie.endpoint;

  // Resolve cookie-mcp server entry point — works for both local dev and
  // global npm install (where process.cwd() is unrelated to the package).
  // 1) Try require.resolve relative to the package's own node_modules
  // 2) Fall back to npx which resolves from the global store
  let serverCmd: string;
  let serverArgs: string[];
  try {
    // require.resolve works from any file inside the installed package — it
    // walks up from __dirname looking for node_modules/cookie-mcp.
    const resolved = require.resolve("cookie-mcp/dist/mcp/server.js");
    serverCmd = "node";
    serverArgs = [resolved];
    auditLog(`resolved cookie-mcp at ${resolved}`);
  } catch {
    serverCmd = "npx";
    serverArgs = ["-y", "cookie-mcp"];
    auditLog("cookie-mcp not found locally — falling back to npx");
  }

  transport = new StdioClientTransport({
    command: serverCmd,
    args: serverArgs,
    env: {
      COOKIE_RPC_URL: cookieRpcUrl,
      // SECURITY: Never set COOKIE_PRIVATE_KEY — read-only integration.
    },
    stderr: "pipe",
  });

  // Capture child stderr for debugging
  transport.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) auditLog(`child stderr: ${line}`);
  });

  const client = new Client(
    { name: "bake", version: VERSION },
    { capabilities: {} },
  );

  clientPromise = (async () => {
    try {
      const connectPromise = client.connect(transport!);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("cookie-mcp connection timed out after 60s")),
          CONNECT_TIMEOUT_MS,
        ),
      );

      await Promise.race([connectPromise, timeoutPromise]);
      auditLog("cookie-mcp connected");
      return client;
    } catch (err) {
      auditLog(`cookie-mcp connection failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  })();

  try {
    return await clientPromise;
  } catch (err) {
    // Reset so subsequent calls retry
    clientPromise = null;
    transport = null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cleanup on process exit
// ---------------------------------------------------------------------------

function cleanup() {
  if (transport) {
    transport.close().catch(() => {});
    transport = null;
  }
  clientPromise = null;
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Tool call helpers
// ---------------------------------------------------------------------------

function isBase58Pubkey(input: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input);
}

/**
 * Check token liquidity info via cookie-mcp.
 *
 * Accepts either a mint address (base58 pubkey) or a token symbol/name.
 * If the input looks like a symbol (not a valid pubkey), search_tokens is
 * called first to resolve it to a mint address.
 */
export async function getCookieTokenInfo(
  mintOrSymbol: string,
): Promise<CookieTokenInfo> {
  const client = await getClient();

  let mint = mintOrSymbol;
  let symbol: string | null = null;
  let name: string | null = null;

  // If not a valid pubkey, search by symbol/name first
  if (!isBase58Pubkey(mintOrSymbol)) {
    auditLog(`search_tokens: "${mintOrSymbol}"`);
    const searchResult = await client.callTool({
      name: "search_tokens",
      arguments: { query: mintOrSymbol },
    });

    const searchRaw = extractText(searchResult);
    if (!searchRaw) {
      throw new Error(
        `No results found for "${mintOrSymbol}" — try a token symbol or mint address.`,
      );
    }

    // Parse the search response — may be a JSON string or already an object
    let searchData: unknown;
    try {
      searchData = JSON.parse(searchRaw);
    } catch {
      searchData = searchRaw;
    }

    // Extract first result with a valid mint
    let foundMint: string | null = null;
    let foundSymbol: string | null = null;
    let foundName: string | null = null;

    if (searchData && typeof searchData === "object") {
      const obj = searchData as Record<string, unknown>;
      // search_tokens returns { results: [...] } or may be an array directly
      const results = Array.isArray(obj.results)
        ? obj.results
        : Array.isArray(searchData)
          ? searchData
          : [];

      for (const r of results) {
        const rec = r as Record<string, unknown>;
        if (rec?.mint && typeof rec.mint === "string" && isBase58Pubkey(rec.mint)) {
          foundMint = rec.mint;
          foundSymbol = typeof rec.symbol === "string" ? rec.symbol : null;
          foundName = typeof rec.name === "string" ? rec.name : null;
          break;
        }
      }
    }

    if (!foundMint) {
      throw new Error(
        `No valid mint found for "${mintOrSymbol}" — try a token mint address.`,
      );
    }

    mint = foundMint;
    symbol = foundSymbol;
    name = foundName;
  }

  // Get token info
  auditLog(`get_token_info: ${mint}`);
  const infoResult = await client.callTool({
    name: "get_token_info",
    arguments: { mint },
  });

  // Check for error response from cookie-mcp
  if (infoResult && typeof infoResult === "object" && "isError" in infoResult && infoResult.isError) {
    const errorText = extractText(infoResult);
    const errorData = errorText ? safeParse(errorText) : null;
    const errorMsg = (errorData && typeof errorData === "object" && "error" in errorData)
      ? String((errorData as { error: unknown }).error)
      : errorText ?? "Token not found";
    throw new Error(errorMsg);
  }

  const infoData = extractText(infoResult);
  if (!infoData) {
    throw new Error(`No token info returned for mint ${mint}.`);
  }

  const infoParsed = safeParse(infoData);
  const infoObj = (infoParsed && typeof infoParsed === "object"
    ? infoParsed
    : {}) as Record<string, unknown>;

  // Get pool info — filter to pools that include this mint as base or quote
  let pools: { address: string; type: string; tvlUsd: number }[] = [];
  try {
    auditLog(`get_pools: ${mint}`);
    const poolsResult = await client.callTool({
      name: "get_pools",
      arguments: { mint },
    });
    const poolsData = extractText(poolsResult);
    if (poolsData) {
      const poolsParsed = safeParse(poolsData) as Record<string, unknown> | null;
      const poolList = poolsParsed && typeof poolsParsed === "object" && Array.isArray(poolsParsed.pools)
        ? (poolsParsed.pools as Record<string, unknown>[])
        : [];
      pools = poolList
        .filter((p) => {
          const base = p.base as Record<string, unknown> | undefined;
          const quote = p.quote as Record<string, unknown> | undefined;
          return (base?.mint === mint) || (quote?.mint === mint);
        })
        .map((p) => ({
          address: String(p.poolId ?? ""),
          type: String(p.venue ?? "unknown"),
          tvlUsd: typeof p.tvlUsd === "number" ? p.tvlUsd : 0,
        }));
    }
  } catch {
    // Pool lookup is optional — don't fail the whole call
  }

  // Determine liquidity from token info fields (liquidityCook / liquidityUsd)
  const liqCook = typeof infoObj.liquidityCook === "number" ? infoObj.liquidityCook : 0;
  const liqUsd = typeof infoObj.liquidityUsd === "number" ? infoObj.liquidityUsd : 0;
  const hasLiquidity = liqCook > 0 || liqUsd > 0 || pools.length > 0;

  return {
    mint,
    symbol: symbol ?? (infoObj.symbol as string) ?? null,
    name: name ?? (infoObj.name as string) ?? null,
    priceUsd: typeof infoObj.priceUsd === "number" ? infoObj.priceUsd
      : typeof infoObj.price === "number" ? infoObj.price
      : null,
    hasLiquidity,
    isOnLaunchpad: Boolean(infoObj.isOnLaunchpad ?? infoObj.launchpad),
    pools,
    raw: infoObj,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function extractText(result: unknown): string | null {
  const r = result as {
    content?: { type: string; text: string }[];
    text?: string;
  };
  if (r?.content && Array.isArray(r.content)) {
    const textBlock = r.content.find(
      (c: { type: string }) => c.type === "text",
    );
    return textBlock?.text ?? null;
  }
  if (typeof r?.text === "string") return r.text;
  return null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
