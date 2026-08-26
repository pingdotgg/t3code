// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - process launcher, deliberately Effect-free.
/**
 * Node desktop host for the Qt shell.
 *
 * Spawned by t3code-qt (see src/BackendProcess.cpp). Starts the T3 server,
 * announces its pairing URL on stdout as one JSON line, then keeps the server
 * alive until the shell goes away. Everything TypeScript-owned (server
 * lifecycle, and later SSH/Tailscale/secrets/updates) lives on this side; the
 * Qt process only ever sees the URL.
 *
 * Protocol (stdout, newline-delimited JSON):
 *   {"type":"ready","url":"http://..."}   server accepts connections at url
 *   {"type":"error","message":"..."}       fatal, the host is exiting
 *   {"type":"exit","code":n}               server process ended
 * stdin closing means the shell is gone: shut the server down.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { parsePairingUrlLine } from "./pairingUrl.ts";

type HostMessage =
  | { readonly type: "ready"; readonly url: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "exit"; readonly code: number | null; readonly signal: string | null };

function emit(message: HostMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const hostDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const serverEntry =
  process.env.T3CODE_SERVER_ENTRY ?? NodePath.resolve(hostDir, "../../server/src/bin.ts");

const serverArgs = ["--no-browser", ...process.argv.slice(2)];
const server = NodeChildProcess.spawn(process.execPath, [serverEntry, ...serverArgs], {
  stdio: ["ignore", "pipe", "inherit"],
  env: process.env,
});

let announced = false;
const lines = NodeReadline.createInterface({ input: server.stdout });
lines.on("line", (line) => {
  process.stderr.write(`${line}\n`);
  if (announced) return;
  const url = parsePairingUrlLine(line);
  if (url !== undefined) {
    announced = true;
    emit({ type: "ready", url });
  }
});

server.on("error", (error) => {
  emit({ type: "error", message: `Failed to start server: ${error.message}` });
  process.exit(1);
});

server.on("exit", (code, signal) => {
  if (!announced) {
    emit({
      type: "error",
      message: `Server exited before announcing a pairing URL (code ${String(code)}).`,
    });
  }
  emit({ type: "exit", code, signal });
  process.exit(code ?? 0);
});

let stopping = false;
function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
  setTimeout(() => server.kill("SIGKILL"), 5_000).unref();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => stop("SIGTERM"));
}
// The shell holds our stdin open; EOF means it exited (cleanly or not).
process.stdin.on("end", () => stop("SIGTERM"));
process.stdin.on("error", () => stop("SIGTERM"));
process.stdin.resume();
