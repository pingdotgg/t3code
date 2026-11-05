// @effect-diagnostics nodeBuiltinImport:off - the launcher loads only Node builtins so it starts in milliseconds.
import * as NodeChildProcess from "node:child_process";
import type * as NodeNet from "node:net";

export interface LauncherSpawnRequest {
  readonly type: "spawn";
  readonly id: number;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: NodeChildProcess.SpawnOptions;
}

export interface LauncherError {
  readonly message: string;
  readonly code?: string | undefined;
  readonly errno?: number | undefined;
  readonly syscall?: string | undefined;
  readonly path?: string | undefined;
}

/** Per child, in order: `pid`, `stdio` per piped fd (carrying its socket), `spawn`, then `exit`; or `error`. */
export type LauncherEvent =
  | { readonly type: "ready" }
  | { readonly type: "pid"; readonly id: number; readonly pid: number }
  | { readonly type: "stdio"; readonly id: number; readonly fd: number }
  | { readonly type: "spawn"; readonly id: number }
  | {
      readonly type: "exit";
      readonly id: number;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly type: "error"; readonly id: number; readonly error: LauncherError };

// Leaves out spawnargs; the server's spawner redacts its own copy.
const toLauncherError = (cause: unknown): LauncherError => {
  const error = cause as Partial<NodeJS.ErrnoException> | undefined;
  return {
    message: typeof error?.message === "string" ? error.message : String(cause),
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
    path: error?.path,
  };
};

// Child stdio has no public paused option; this is what net's pauseOnCreate does.
const stopReading = (socket: NodeNet.Socket) =>
  (socket as unknown as { _handle?: { readStop?: () => void } | null })._handle?.readStop?.();

// Bundled import.meta.main is always true; importing this module must have no side effects.
export function runProcessLauncher(): void {
  const channel = process.send?.bind(process);
  if (!channel) {
    process.stderr.write("The process launcher is started by the T3 server.\n");
    process.exitCode = 1;
    return;
  }
  const send = (event: LauncherEvent, socket?: NodeNet.Socket) =>
    channel(event, socket, undefined, () => {});
  const children = new Map<number, NodeChildProcess.ChildProcess>();

  // Group signals target the server; this process exits when the server's channel closes.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});
  process.on("disconnect", () => {
    for (const child of children.values()) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    process.exit(0);
  });

  process.on("message", (request: LauncherSpawnRequest) => {
    const { id } = request;
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(request.command, [...request.args], request.options);
    } catch (cause) {
      send({ type: "error", id, error: toLauncherError(cause) });
      return;
    }
    const stdio = child.stdio.map((socket) => socket as NodeNet.Socket | null);
    // The server reads and writes these pipes itself, so no byte may be consumed here.
    for (const socket of stdio) if (socket) stopReading(socket);
    // Node flushes and destroys a child's stdio at exit, even while a socket waits to be sent.
    child.stdin = null;
    child.stdout = null;
    child.stderr = null;
    child.stdio.fill(null);
    child.on("error", (cause) => {
      if (child.pid === undefined) for (const socket of stdio) socket?.destroy();
      send({ type: "error", id, error: toLauncherError(cause) });
    });
    child.once("spawn", () => {
      children.set(id, child);
      // First, so the server can kill the child if this process dies while handing over its pipes.
      send({ type: "pid", id, pid: child.pid! });
      stdio.forEach((socket, fd) => {
        if (socket) send({ type: "stdio", id, fd }, socket);
      });
      send({ type: "spawn", id });
    });
    child.once("exit", (code, signal) => {
      children.delete(id);
      send({ type: "exit", id, code, signal });
    });
  });
  send({ type: "ready" });
}
