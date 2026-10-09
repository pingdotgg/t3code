// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- The guard runs in Node's unhandled-rejection callback, outside an Effect runtime. stderr must match Node's default unhandled-rejection print.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Agent, createAgentPlatform } from "./sdk.ts";

/**
 * The Cursor Agent SDK runs in this process and spawns a shell for tool
 * calls. The command is Cursor's sandbox wrapper (`dump_zsh_state`,
 * `dump_bash_state`, `__CURSOR_SANDBOX_ENV_RESTORE`). A bad working directory
 * makes Node report `spawn /bin/zsh ENOENT`. The SDK listens for that error,
 * then rejects an internal promise nothing awaits. Node exits on that
 * unhandled rejection and takes the server with it.
 *
 * The guard ignores only that rejection. Every other unhandled rejection
 * still prints and exits when this is the process's only listener, matching
 * Node's default. `child_process.spawn` itself is left alone, so git,
 * terminals, and other providers keep their own error handling.
 */
const CURSOR_SHELL_SPAWN_MARKERS = [
  "dump_zsh_state",
  "dump_bash_state",
  "__CURSOR_SANDBOX_ENV_RESTORE",
] as const;

export function isCursorShellSpawnFailure(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) {
    return false;
  }
  const syscall = Reflect.get(reason, "syscall");
  const code = Reflect.get(reason, "code");
  const spawnargs = Reflect.get(reason, "spawnargs");
  if (typeof syscall !== "string" || !syscall.startsWith("spawn") || typeof code !== "string") {
    return false;
  }
  if (!Array.isArray(spawnargs)) {
    return false;
  }
  return spawnargs.some(
    (arg) =>
      typeof arg === "string" && CURSOR_SHELL_SPAWN_MARKERS.some((marker) => arg.includes(marker)),
  );
}

function onUnhandledRejection(reason: unknown): void {
  if (isCursorShellSpawnFailure(reason)) {
    console.error("Cursor shell spawn failed. The server will keep running.", reason);
    return;
  }
  // Another handler registered besides this one owns the decision.
  if (process.listenerCount("unhandledRejection") > 1) {
    return;
  }
  console.error(reason);
  process.exit(1);
}

/**
 * The SDK entry points that run agents in this process. Reaching them through
 * this service keeps the shell spawn guard armed while they are in use.
 */
export class CursorSdk extends Context.Service<
  CursorSdk,
  {
    readonly Agent: typeof Agent;
    readonly createAgentPlatform: typeof createAgentPlatform;
  }
>()("@t3tools/provider-cursor/server/CursorSdk") {}

/** Provide once per process: a second guard would defer to the first and swallow real rejections. */
export const layer = Layer.effect(
  CursorSdk,
  Effect.acquireRelease(
    Effect.sync(() => {
      process.on("unhandledRejection", onUnhandledRejection);
    }),
    () =>
      Effect.sync(() => {
        process.off("unhandledRejection", onUnhandledRejection);
      }),
  ).pipe(Effect.as(CursorSdk.of({ Agent, createAgentPlatform }))),
);
