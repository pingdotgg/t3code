import type * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as EffectAcpSchema from "effect-acp/schema";

/**
 * Self-contained stdio ↔ streamable-HTTP MCP bridge.
 *
 * ACP agents that only accept stdio MCP servers (Devin's `devin acp` advertises
 * `mcpCapabilities: { http: false, sse: false }`) cannot consume the T3 Code
 * streamable-HTTP MCP endpoint directly. We write this script into the state
 * directory and register it as `node <path>` so the agent launches it like any
 * other stdio MCP server.
 *
 * The script must be plain JavaScript: it runs under whatever Node binary hosts
 * the server, with no build step and no repo imports. stdout is reserved for
 * JSON-RPC; everything diagnostic goes to stderr.
 */
export const MCP_STDIO_BRIDGE_SOURCE = `#!/usr/bin/env node
import { createInterface } from "node:readline";

const endpoint = process.env.T3_MCP_ENDPOINT;
const authorization = process.env.T3_MCP_AUTHORIZATION;
if (!endpoint) {
  process.stderr.write("T3_MCP_ENDPOINT is required\\n");
  process.exit(2);
}

let sessionId;
let protocolVersion;
// Followers must not reach the stateful endpoint before "initialize" returns
// its mcp-session-id header, so non-initialize messages await this promise.
let sessionReady;
let pendingWrites = Promise.resolve();
const writer = process.stdout;

function writeMessage(message) {
  pendingWrites = pendingWrites.then(
    () =>
      new Promise((resolve) => {
        writer.write(JSON.stringify(message) + "\\n", () => resolve());
      }),
  );
}

function respondError(id, message) {
  writeMessage({ jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message } });
}

async function postMessage(line, parsed) {
  const isInitialize = parsed && parsed.method === "initialize";
  if (!isInitialize && !sessionId && sessionReady) {
    await sessionReady;
  }
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (authorization) headers.authorization = authorization;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;

  const response = await fetch(endpoint, { method: "POST", headers, body: line });
  sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  protocolVersion = response.headers.get("mcp-protocol-version") ?? protocolVersion;

  if (!response.ok) {
    await response.arrayBuffer();
    if (parsed && typeof parsed === "object" && "id" in parsed) {
      respondError(parsed.id, "MCP endpoint returned HTTP " + response.status + ".");
    }
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    for (const message of parseSseEvents(await response.text())) {
      writeMessage(message);
    }
    return;
  }

  const text = await response.text();
  if (text.trim()) {
    try {
      const payload = JSON.parse(text);
      for (const message of Array.isArray(payload) ? payload : [payload]) {
        writeMessage(message);
      }
      return;
    } catch {
      // Fall through and synthesize an error below.
    }
  }
}

function* parseSseEvents(body) {
  let data = [];
  const flush = function* () {
    if (data.length === 0) return;
    try {
      yield JSON.parse(data.join("\\n"));
    } catch {
      // Ignore unparseable SSE payloads.
    }
    data = [];
  };
  for (const line of body.split(/\\r?\\n/)) {
    if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    } else if (line.trim() === "") {
      yield* flush();
    }
  }
  yield* flush();
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

async function main() {
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      respondError(null, "Parse error");
      continue;
    }
    const pending = postMessage(trimmed, parsed).catch((error) => {
      if (parsed && typeof parsed === "object" && "id" in parsed) {
        respondError(parsed.id, String(error instanceof Error ? error.message : error));
      }
    });
    if (parsed && parsed.method === "initialize" && sessionReady === undefined) {
      sessionReady = pending.then(
        () => {},
        () => {},
      );
    }
  }
  await pendingWrites;
}

main();
`;

export const MCP_STDIO_BRIDGE_FILE_NAME = "mcp-stdio-bridge.mjs";

// Concurrent writers in one process share the pid, so a counter keeps each
// temporary file unique.
let bridgeWriteCounter = 0;

/**
 * Ensures the bridge script exists under `stateDir` and returns its absolute
 * path. Reuses an up-to-date copy so warm restarts do not rewrite the file.
 */
export const ensureMcpStdioBridge = (
  stateDir: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bridgePath = path.join(stateDir, MCP_STDIO_BRIDGE_FILE_NAME);
    const existing = yield* fileSystem.readFileString(bridgePath).pipe(Effect.option);
    if (existing._tag === "Some" && existing.value === MCP_STDIO_BRIDGE_SOURCE) {
      return bridgePath;
    }
    yield* fileSystem.makeDirectory(stateDir, { recursive: true });
    const tempPath = `${bridgePath}.${process.pid}.${bridgeWriteCounter++}.tmp`;
    yield* fileSystem.writeFileString(tempPath, MCP_STDIO_BRIDGE_SOURCE);
    yield* fileSystem.rename(tempPath, bridgePath);
    return bridgePath;
  });

/**
 * Builds the ACP `session/new` stdio MCP entry that launches the bridge. The
 * endpoint URL and bearer header travel through the child environment so the
 * bridge needs no arguments.
 */
export const mcpStdioBridgeEntry = (input: {
  readonly bridgePath: string;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly name?: string;
}): EffectAcpSchema.McpServer => ({
  name: input.name ?? "t3-code",
  command: process.execPath,
  args: [input.bridgePath],
  env: [
    { name: "T3_MCP_ENDPOINT", value: input.endpoint },
    { name: "T3_MCP_AUTHORIZATION", value: input.authorizationHeader },
  ],
});
