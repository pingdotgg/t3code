// @effect-diagnostics nodeBuiltinImport:off - the host runs without the Effect runtime to stay small.
// `t3 __spawn-host` must import only Node builtins to keep its heap small.
// Transfer stdio sockets over IPC so output bypasses the host.
import * as NodeChildProcess from "node:child_process";
import type * as NodeNet from "node:net";

export interface SpawnHostSpawnRequest {
  readonly type: "spawn";
  readonly id: number;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: NodeChildProcess.SpawnOptions;
}

export interface SpawnHostError {
  readonly message: string;
  readonly code?: string | undefined;
  readonly errno?: number | undefined;
  readonly syscall?: string | undefined;
  readonly path?: string | undefined;
  readonly spawnargs?: ReadonlyArray<string> | undefined;
}

/** Sent in order per child: `stdio` once per piped fd (carrying the socket), `spawn`, then `exit`. */
export type SpawnHostEvent =
  | { readonly type: "ready" }
  | { readonly type: "stdio"; readonly id: number; readonly fd: number }
  | { readonly type: "spawn"; readonly id: number; readonly pid: number }
  | {
      readonly type: "exit";
      readonly id: number;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly type: "error"; readonly id: number; readonly error: SpawnHostError };

const toSpawnHostError = (cause: unknown): SpawnHostError => {
  const error = cause as Partial<NodeJS.ErrnoException> & { spawnargs?: ReadonlyArray<string> };
  return {
    message: typeof error?.message === "string" ? error.message : String(cause),
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
    path: error?.path,
    spawnargs: error?.spawnargs,
  };
};

// Child stdio has no public paused option; use net's pauseOnCreate mechanism.
const stopReading = (socket: NodeNet.Socket) =>
  (socket as unknown as { _handle?: { readStop?: () => void } | null })._handle?.readStop?.();

export function runSpawnHost(): void {
  const channel = process.send?.bind(process);
  if (!channel) {
    process.stderr.write("t3 __spawn-host is started by the T3 server.\n");
    process.exitCode = 1;
    return;
  }
  const send = (event: SpawnHostEvent, socket?: NodeNet.Socket) => channel(event, socket);

  // Keep reporting exits during group shutdown until the server closes IPC.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});
  process.on("disconnect", () => process.exit(0));

  process.on("message", (request: SpawnHostSpawnRequest) => {
    if (request.type !== "spawn") return;
    const { id } = request;
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(request.command, [...request.args], request.options);
    } catch (cause) {
      send({ type: "error", id, error: toSpawnHostError(cause) });
      return;
    }
    // Stop reads before the loop polls, preserving every byte for the server.
    const stdio = child.stdio.map((socket) => {
      if (socket) stopReading(socket as NodeNet.Socket);
      return socket as NodeNet.Socket | null;
    });
    // ChildProcess destroys stdin on exit, which can come before its socket leaves the send queue.
    child.stdin = null;
    child.on("error", (cause) => send({ type: "error", id, error: toSpawnHostError(cause) }));
    child.once("spawn", () => {
      stdio.forEach((socket, fd) => {
        if (socket) send({ type: "stdio", id, fd }, socket);
      });
      send({ type: "spawn", id, pid: child.pid! });
    });
    child.on("exit", (code, signal) => send({ type: "exit", id, code, signal }));
  });
  send({ type: "ready" });
}
