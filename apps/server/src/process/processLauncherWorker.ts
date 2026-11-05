// @effect-diagnostics nodeBuiltinImport:off - the launcher loads only Node builtins so it starts in milliseconds.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

export type LauncherRequest =
  | {
      readonly type: "spawn";
      readonly id: number;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd: string | undefined;
      readonly env: NodeJS.ProcessEnv;
      readonly shell: boolean | string | undefined;
    }
  | { readonly type: "stdin"; readonly id: number; readonly chunk: Uint8Array }
  | { readonly type: "stdinEnd"; readonly id: number };

export interface LauncherSpawnFailure {
  readonly method: "access" | "spawn";
  readonly message: string;
  readonly code: string | undefined;
  readonly errno: number | undefined;
  readonly syscall: string | undefined;
  readonly path: string | undefined;
}

/** Per child, in order: `spawned` or `failed`, then output, `outputEnd` per stream, and `exit`. */
export type LauncherEvent =
  | { readonly type: "ready" }
  | { readonly type: "spawned"; readonly id: number; readonly pid: number }
  | { readonly type: "failed"; readonly id: number; readonly failure: LauncherSpawnFailure }
  | {
      readonly type: "output";
      readonly id: number;
      readonly stream: "stdout" | "stderr";
      readonly chunk: Uint8Array;
    }
  | { readonly type: "outputEnd"; readonly id: number; readonly stream: "stdout" | "stderr" }
  | {
      readonly type: "exit";
      readonly id: number;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

const toFailure = (
  method: LauncherSpawnFailure["method"],
  cause: unknown,
): LauncherSpawnFailure => {
  const error = cause as Partial<NodeJS.ErrnoException> | undefined;
  return {
    method,
    message: typeof error?.message === "string" ? error.message : String(cause),
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
    path: error?.path,
  };
};

// Bundled import.meta.main is always true; importing this module must have no side effects.
export function runProcessLauncher(): void {
  const channel = process.send?.bind(process);
  if (!channel) {
    process.stderr.write("The process launcher is started by the T3 server.\n");
    process.exitCode = 1;
    return;
  }
  const send = (event: LauncherEvent) => channel(event, undefined, undefined, () => {});
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

  const spawn = (request: Extract<LauncherRequest, { type: "spawn" }>) => {
    const { id } = request;
    if (request.cwd !== undefined) {
      try {
        NodeFS.accessSync(request.cwd);
      } catch (cause) {
        send({ type: "failed", id, failure: toFailure("access", cause) });
        return;
      }
    }
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        shell: request.shell,
        detached: true,
        stdio: "pipe",
      });
    } catch (cause) {
      send({ type: "failed", id, failure: toFailure("spawn", cause) });
      return;
    }
    if (child.pid !== undefined) children.set(id, child);
    child.on("error", (cause) => {
      if (child.pid === undefined) send({ type: "failed", id, failure: toFailure("spawn", cause) });
    });
    child.once("spawn", () => send({ type: "spawned", id, pid: child.pid! }));
    child.stdin!.on("error", () => {});
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]!.on("data", (chunk: Uint8Array) => send({ type: "output", id, stream, chunk }));
      child[stream]!.once("close", () => send({ type: "outputEnd", id, stream }));
    }
    child.once("exit", (code, signal) => {
      children.delete(id);
      send({ type: "exit", id, code, signal });
    });
  };

  process.on("message", (request: LauncherRequest) => {
    switch (request.type) {
      case "spawn":
        spawn(request);
        break;
      case "stdin":
        children.get(request.id)?.stdin?.write(request.chunk);
        break;
      case "stdinEnd":
        children.get(request.id)?.stdin?.end();
        break;
    }
  });
  send({ type: "ready" });
}
