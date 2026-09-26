// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";

/**
 * The Cursor Agent SDK runs in this process and spawns a shell for tool
 * calls. The command is Cursor's sandbox wrapper (`dump_zsh_state`,
 * `dump_bash_state`, `__CURSOR_SANDBOX_ENV_RESTORE`). A bad working directory
 * makes Node report `spawn /bin/zsh ENOENT`. The SDK listens for that error,
 * then rejects an internal promise nothing awaits. Node exits on that
 * unhandled rejection and takes the server with it.
 *
 * This listener ignores only that rejection. Every other unhandled rejection
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

let cursorShellSpawnGuardInstalled = false;

function installCursorShellSpawnGuard(): void {
  if (cursorShellSpawnGuardInstalled) {
    return;
  }
  cursorShellSpawnGuardInstalled = true;

  process.on("unhandledRejection", (reason) => {
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
  });
}

// Arm before the SDK loads. Its shell tools spawn from this process.
installCursorShellSpawnGuard();

// Cursor's Webpack chunks and local helpers must stay beside the SDK entry.
// createRequire also loads that disk-backed package from a Node SEA executable.
const requireCursorSdk = NodeModule.createRequire(import.meta.url);
export const { Agent, AuthenticationError, Cursor, CursorSdkError, InMemoryCredentialStore } =
  requireCursorSdk("@cursor/sdk") as typeof import("@cursor/sdk");
