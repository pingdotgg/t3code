import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makePool } from "./windowsProcessWorker.ts";

type Spawn = (
  command: ChildProcess.StandardCommand,
) => Effect.Effect<
  Pick<ChildProcessSpawner.ChildProcessHandle, "stdin" | "stdout" | "stderr" | "exitCode">,
  PlatformError.PlatformError,
  Scope.Scope
>;

export const WindowsSpawn = Context.Reference<Spawn | undefined>("t3/WindowsSpawn", {
  defaultValue: () => undefined,
});

export const layer = Layer.effect(
  WindowsSpawn,
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "win32") return undefined;
    const fs = yield* FileSystem.FileSystem;
    const pool = yield* Effect.acquireRelease(Effect.sync(makePool), (pool) =>
      Effect.promise(() => pool.close()),
    );
    const error = (cause: unknown) =>
      PlatformError.systemError({
        _tag:
          typeof cause === "object" && cause !== null && "code" in cause
            ? cause.code === "ENOENT"
              ? "NotFound"
              : cause.code === "EACCES" || cause.code === "EPERM"
                ? "PermissionDenied"
                : "Unknown"
            : "Unknown",
        module: "ChildProcess",
        method: "spawn",
        description: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    const spawn: Spawn = Effect.fn("WindowsSpawn.spawn")(function* (command) {
      if (command.options.cwd !== undefined) yield* fs.access(command.options.cwd);
      const job = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            pool.start({
              command: command.command,
              args: command.args.map((arg) =>
                Redacted.isRedacted(arg) ? Redacted.value(arg) : arg,
              ),
              cwd: command.options.cwd,
              env: Object.fromEntries(
                Object.entries({
                  ...(command.options.env === undefined || command.options.extendEnv === true
                    ? process.env
                    : {}),
                  ...command.options.env,
                }).map(([key, value]) => [
                  key,
                  Redacted.isRedacted(value) ? Redacted.value(value) : value,
                ]),
              ),
              shell: command.options.shell ?? false,
              detached: command.options.detached,
              windowsHide: command.options.windowsHide ?? true,
            }),
          catch: error,
        }),
        (job) => Effect.promise(() => job.dispose()),
      );
      const streams = yield* Effect.tryPromise({ try: () => job.started, catch: error });
      return {
        stdin: Sink.fromWritableStream({ evaluate: () => streams.stdin, onError: error }),
        stdout: Stream.fromReadableStream({ evaluate: () => streams.stdout, onError: error }),
        stderr: Stream.fromReadableStream({ evaluate: () => streams.stderr, onError: error }),
        exitCode: Effect.tryPromise({ try: () => job.exit, catch: error }).pipe(
          Effect.map(ChildProcessSpawner.ExitCode),
        ),
      };
    });
    return spawn;
  }),
);
