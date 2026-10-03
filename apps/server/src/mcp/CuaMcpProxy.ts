/**
 * A stdio proxy between a provider and `cua-driver mcp`, one per provider
 * session. Cua ends a session, and removes its cursor, when the MCP process
 * that owns it exits. To end a thread's session T3 connects to the proxy's
 * control socket; the proxy stops its `cua-driver mcp` child and starts a fresh
 * one on the next request, replaying the client's `initialize`, so the
 * provider keeps one MCP connection for its whole life.
 *
 * The proxy also exits, ending its session, when its stdin closes or the T3
 * server that launched it dies. The socket is per thread, so a newer proxy for
 * the same thread (a replacement provider session) takes the path over.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "../atomicWrite.ts";

const PROXY_FILE = "computer/cua-mcp-proxy.mjs";

// Plain JavaScript run with the server's Node runtime. MCP stdio is
// newline-delimited JSON-RPC.
const PROXY_SOURCE = `import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:net";

const driver = process.env.T3_CUA_DRIVER;
const controlPath = process.env.T3_CUA_CONTROL;
const serverPid = Number(process.env.T3_SERVER_PID);

let child = null;
let ready = false;
let restarted = false;
let initialize = null;
let initialized = false;
let queue = [];
let replayCount = 0;
const pending = new Set();

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};
const isRequest = (message) => message !== null && "id" in message && "method" in message;

// Requests the old child never answered fail, so the provider is not left waiting.
function failPending() {
  for (const id of pending) {
    const message = "Computer use stopped. Call the tool again to start a new session.";
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\\n");
  }
  pending.clear();
  queue = [];
}

function start() {
  const current = spawn(driver, ["mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  let replay = restarted && initialize ? "t3-replay-" + ++replayCount : null;
  child = current;
  ready = replay === null;
  let buffer = "";
  current.stdin.on("error", () => {});
  current.stdout.on("data", (chunk) => {
    // A replaced driver can still flush output; its calls were already failed.
    if (child !== current) return;
    buffer += chunk;
    const lines = buffer.split("\\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = parse(line);
      if (replay !== null && message?.id === replay) {
        replay = null;
        // A driver that refuses the replayed handshake cannot serve the
        // queued calls; they fail, and the next call starts a new driver.
        if (message.error !== undefined) {
          child = null;
          current.kill();
          failPending();
          return;
        }
        if (initialized) {
          current.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n");
        }
        // Only the first match is the replayed handshake; later ones are the client's.
        ready = true;
        flush();
        continue;
      }
      if (message !== null && "id" in message && !("method" in message)) pending.delete(message.id);
      process.stdout.write(line + "\\n");
    }
  });
  // A driver that fails to start, or later exits, fails the waiting calls;
  // the next call tries again.
  const stopped = () => {
    if (child !== current) return;
    child = null;
    restarted = true;
    failPending();
  };
  current.on("error", stopped);
  current.on("exit", stopped);
  if (replay !== null) current.stdin.write(JSON.stringify({ ...initialize, id: replay }) + "\\n");
}

function flush() {
  if (child === null || !ready) return;
  for (const line of queue) child.stdin.write(line + "\\n");
  queue = [];
}

function fromClient(line) {
  const message = parse(line);
  if (message?.method === "initialize" && initialize === null) initialize = message;
  if (message?.method === "notifications/initialized") initialized = true;
  if (isRequest(message)) pending.add(message.id);
  queue.push(line);
  if (child === null) start();
  flush();
}

function end() {
  const current = child;
  child = null;
  restarted = true;
  current?.kill();
  failPending();
}

// The socket file stays behind on exit: a newer proxy for the same thread may
// already own the path, and a stale file only refuses connections.
function shutdown() {
  child?.kill();
  process.exit(0);
}

// A newer proxy for the thread takes the path over from an older one.
if (!process.platform.startsWith("win")) rmSync(controlPath, { force: true });
// A connection is the whole message: end the session, then close the
// connection, which tells T3 the session has ended. Without the socket the
// session still ends when this proxy exits, so a failed listen is not fatal.
createServer((socket) => {
  end();
  socket.destroy();
})
  .on("error", (error) => console.error("cua-mcp-proxy: control socket failed:", error.message))
  .listen(controlPath);

if (Number.isInteger(serverPid) && serverPid > 0) {
  setInterval(() => {
    try {
      process.kill(serverPid, 0);
    } catch {
      shutdown();
    }
  }, 2000).unref();
}

let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  const lines = input.split("\\n");
  input = lines.pop();
  for (const line of lines) if (line.trim()) fromClient(line);
});
process.stdin.on("end", shutdown);
`;

/**
 * Writes the proxy script under the state dir and returns its path. The write
 * is atomic because a proxy for another thread may be starting from it.
 */
export const ensureCuaMcpProxy = Effect.fn("CuaMcpProxy.ensure")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const proxyPath = path.join(stateDir, PROXY_FILE);
  const current = yield* fs.readFileString(proxyPath).pipe(Effect.orElseSucceed(() => null));
  if (current !== PROXY_SOURCE) {
    yield* writeFileStringAtomically({ filePath: proxyPath, contents: PROXY_SOURCE });
  }
  return proxyPath;
});

/**
 * Where one thread's proxy listens. Kept short because macOS limits Unix
 * socket paths to about 100 bytes, which a worktree state dir can exceed.
 */
export const cuaControlPath = Effect.fn("CuaMcpProxy.controlPath")(function* (
  stateDir: string,
  threadId: string,
) {
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const name = `t3-cua-${NodeCrypto.createHash("sha256").update(`${stateDir}\0${threadId}`).digest("hex").slice(0, 16)}`;
  return platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(NodeOS.tmpdir(), `${name}.sock`);
});

/**
 * Asks a proxy to end its Cua session and waits until it has: the proxy closes
 * the connection after ending it. A proxy that is not running means there is
 * nothing to end, and a stuck one is not waited on for long.
 */
export const endCuaSession = (controlPath: string) =>
  Effect.callback<void>((resume) => {
    const socket = NodeNet.connect(controlPath);
    socket.once("close", () => resume(Effect.void));
    // An error is followed by `close`.
    socket.once("error", () => {});
    return Effect.sync(() => socket.destroy());
  }).pipe(Effect.timeout("2 seconds"), Effect.ignore);
