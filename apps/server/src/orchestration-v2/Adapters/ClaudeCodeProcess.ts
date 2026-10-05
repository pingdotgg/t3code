// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { signalProcessGroup } from "../../process/processGroup.ts";
import * as ProviderProcessLedger from "../../provider/ProviderProcessLedger.ts";
import { redactProviderFailureText } from "../ProviderFailure.ts";

// The SDK's own spawn quotes this much stderr in exit errors, and reports an
// exit only once stderr has closed or this long after the process exited.
const STDERR_TAIL_LENGTH = 2048;
const STDERR_DRAIN_MS = 200;
const EXIT_AFTER_STDERR = "t3-exit-after-stderr";

export interface ClaudeCodeProcess {
  /** The Agent SDK's `spawnClaudeCodeProcess`. */
  readonly spawn: (options: SpawnOptions) => SpawnedProcess & { readonly pid: number | undefined };
  /**
   * Adds the CLI's redacted stderr tail to an error raised after the CLI
   * exited. The SDK only does this for processes it spawns itself.
   */
  readonly withStderr: (cause: unknown) => unknown;
}

/**
 * Builds a per-query Claude Code process spawner on macOS and Linux, and
 * nothing on Windows.
 *
 * The SDK's own spawn leaves the CLI in the T3 server's process group with
 * nothing tying it to the server's life, so a server that is SIGKILLed or
 * crashes leaves its agents working where no thread can see them. Here the
 * CLI leads its own process group and is recorded in the provider process
 * ledger until it exits, so the next server start stops it before recovery
 * marks its run cancelled. When the CLI exits, whatever it left in its group
 * is stopped with it. Windows keeps the SDK's spawn: libuv puts the CLI
 * in the server's kill-on-close job object, so it already ends with the server.
 */
export const makeClaudeCodeProcessFactory = Effect.gen(function* () {
  if ((yield* HostProcessPlatform) === "win32") return undefined;
  const ledger = yield* ProviderProcessLedger.ProviderProcessLedger;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  return (): ClaudeCodeProcess => {
    let stderrTail = "";
    let exitReported = false;
    return {
      spawn: (options) => {
        const child = NodeChildProcess.spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          detached: true,
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          if (!exitReported) stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_LENGTH);
        });
        let stderrClosed = false;
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        const reportExit = () => {
          if (exitReported) return;
          exitReported = true;
          clearTimeout(drainTimer);
          child.emit(EXIT_AFTER_STDERR, child.exitCode, child.signalCode);
          // A descendant may still hold stderr open; it must not keep the server's loop busy.
          child.stderr.destroy();
        };
        child.stderr.once("close", () => {
          stderrClosed = true;
          if (child.exitCode !== null || child.signalCode !== null) reportExit();
        });
        child.once("exit", () => {
          if (stderrClosed) reportExit();
          // @effect-diagnostics-next-line globalTimers:off -- the SDK calls these Node callbacks.
          else drainTimer = setTimeout(reportExit, STDERR_DRAIN_MS);
        });
        const pid = child.pid;
        if (pid !== undefined) {
          const recording = runFork(
            ledger.track({ pid, args: options.args, label: "Claude Code" }),
          );
          child.once("exit", () => {
            // Anything the CLI left in its group would outlive the ledger entry.
            try {
              signalProcessGroup(pid, "SIGKILL");
            } catch {
              // The group is already empty.
            }
            runFork(Fiber.join(recording).pipe(Effect.flatten));
          });
        }
        const event = (name: "exit" | "error") => (name === "exit" ? EXIT_AFTER_STDERR : name);
        type Listener = (...args: never[]) => void;
        const asNodeListener = (listener: Listener) => listener as (...args: unknown[]) => void;
        return {
          pid: child.pid,
          stdin: child.stdin,
          stdout: child.stdout,
          get killed() {
            return child.killed;
          },
          get exitCode() {
            return child.exitCode;
          },
          get signalCode() {
            return child.signalCode;
          },
          kill: (signal) => child.kill(signal),
          on: (name: "exit" | "error", listener: Listener) => {
            child.on(event(name), asNodeListener(listener));
          },
          once: (name: "exit" | "error", listener: Listener) => {
            child.once(event(name), asNodeListener(listener));
          },
          off: (name: "exit" | "error", listener: Listener) => {
            child.off(event(name), asNodeListener(listener));
          },
        };
      },
      withStderr: (cause) => {
        const tail = redactProviderFailureText(stderrTail);
        if (exitReported && tail !== "" && cause instanceof Error) {
          if (!cause.message.includes("stderr:"))
            cause.message = `${cause.message}. stderr: ${tail}`;
        }
        return cause;
      },
    };
  };
});
