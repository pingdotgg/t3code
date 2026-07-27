/**
 * Contains props, error tags, and the live service for executing commands.
 * Shared between the `Build`, `Dev`, and `Exec` resources.
 */

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { flow } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError, SystemError } from "effect/PlatformError";
import { BadArgument } from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { ScopedPlanStatusSession } from "../Cli/Cli.ts";
import { isNonInteractive } from "../Util/interactive.ts";

/**
 * Base properties for a command resource.
 */
export interface CommandProps {
  /**
   * The command to run.
   */
  command: string;
  /**
   * Working directory for the command. Defaults to `process.cwd()`.
   */
  cwd?: string;
  /**
   * If set to true, runs the command inside of a shell, defaulting to /bin/sh on UNIX systems and cmd.exe on Windows.
   * It is generally discouraged to use this option, as it can lead to security vulnerabilities and is not portable.
   * If set to a string, runs the command inside of the specified shell.
   * @default false
   */
  shell?: string | boolean;
  /**
   * Extra environment variables passed to the command on top of `process.env`.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
}

export class CommandExecutor extends Context.Service<
  CommandExecutor,
  {
    /**
     * Spawns a command, returning the child process handle.
     */
    readonly spawn: (
      props: CommandProps,
    ) => Effect.Effect<
      ChildProcessSpawner.ChildProcessHandle,
      CommandError,
      Scope.Scope
    >;
    /**
     * Executes a command, returning the exit code, stdout, and stderr.
     * Throws a {@link CommandError} if the command exits with a non-zero exit code.
     */
    readonly run: (
      props: CommandProps,
      session: ScopedPlanStatusSession,
    ) => Effect.Effect<
      { exitCode: number; stdout: string; stderr: string },
      CommandError
    >;
  }
>()("alchemy/Command/CommandExecutor") {}

/**
 * Extends Effect's `PlatformError` to include the command that failed and some command-specific error reasons.
 */
export class CommandError extends Data.TaggedError("CommandError")<{
  command: string;
  reason: SystemError | BadArgument | UnexpectedExit | OutputNotFound;
  cause?: unknown;
}> {
  constructor({
    command,
    reason,
  }: {
    command: string;
    reason: CommandError["reason"];
  }) {
    if ("cause" in reason) {
      super({ command, reason, cause: reason.cause });
    } else {
      super({ command, reason });
    }
  }

  override get message() {
    return `Failed to execute command "${this.command}": ${this.reason.message}`;
  }
}

export const isCommandError = (error: unknown): error is CommandError =>
  Predicate.isTagged(error, "CommandError");

/**
 * Represents when a command exits unexpectedly.
 */
export class UnexpectedExit extends Data.TaggedError("UnexpectedExit")<{
  exitCode: number;
  stderr: string;
}> {
  override get message() {
    return `The command exited with code ${this.exitCode}. Standard error output: ${this.stderr}`;
  }
}

/**
 * Represents when the output directory does not exist.
 */
export class OutputNotFound extends Data.TaggedError("OutputNotFound")<{
  outdir: string;
}> {
  override get message() {
    return `The output directory "${this.outdir}" does not exist.`;
  }
}

export const CommandExecutorLive = () =>
  Layer.effect(
    CommandExecutor,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      /** Parses a command string into a binary and arguments, unless {@link CommandProps.shell} is true. */
      const parseCommand = (
        props: CommandProps,
      ): Effect.Effect<{ bin: string; args: string[] }, CommandError> => {
        if (props.shell) {
          return Effect.succeed({ bin: props.command, args: [] });
        }
        const [bin, ...args] = props.command
          .split(/(\s+)/)
          .filter((part) => !!part.trim());
        if (!bin) {
          return Effect.fail(
            new CommandError({
              command: props.command,
              reason: new BadArgument({
                module: "Command",
                method: "parseCommand",
                description: "Command is empty",
              }),
            }),
          );
        }
        return Effect.succeed({ bin, args });
      };

      /** Spawns a command, returning the child process handle. */
      const spawn = (props: CommandProps) =>
        parseCommand(props).pipe(
          Effect.flatMap(({ bin, args }) =>
            spawner.spawn(
              ChildProcess.make(bin, args, {
                cwd: path.resolve(props.cwd ?? process.cwd()),
                shell: props.shell ?? false,
                env: Object.fromEntries(
                  Object.entries(props.env ?? {}).map(([k, v]) => [
                    k,
                    Redacted.isRedacted(v) ? Redacted.value(v) : v,
                  ]),
                ),
                extendEnv: true,
                stdin: isNonInteractive() ? "ignore" : "inherit",
                stdout: "pipe",
                stderr: "pipe",
                detached: false,
              }),
            ),
          ),
          mapError(props.command),
        );

      /** Collects the output of a stream, tapping each line to a sink. */
      const collect = (
        stream: Stream.Stream<Uint8Array, PlatformError>,
        tap: (chunk: string) => Effect.Effect<void>,
      ) =>
        stream.pipe(
          Stream.decodeText,
          Stream.tapSink(
            Sink.make<string>()(
              flow(Stream.splitLines, Stream.runForEach(tap)),
            ),
          ),
          Stream.mkString,
        );

      /** Maps a PlatformError to a CommandError. */
      const mapError = (command: string) =>
        Effect.mapError((error: PlatformError | CommandError) =>
          error._tag === "CommandError"
            ? error
            : new CommandError({
                command,
                reason: error.reason,
              }),
        );

      return CommandExecutor.of({
        spawn,
        /** Executes a command, returning the exit code, stdout, and stderr. */
        run: (props: CommandProps, session: ScopedPlanStatusSession) =>
          spawn(props).pipe(
            Effect.flatMap((child) =>
              Effect.all(
                {
                  exitCode: child.exitCode,
                  stdout: collect(child.stdout, session.note),
                  stderr: collect(child.stderr, session.note),
                },
                { concurrency: "unbounded" },
              ).pipe(mapError(props.command)),
            ),
            Effect.tap(({ exitCode, stderr }) =>
              exitCode !== 0
                ? Effect.fail(
                    new CommandError({
                      command: props.command,
                      reason: new UnexpectedExit({
                        exitCode,
                        stderr,
                      }),
                    }),
                  )
                : Effect.void,
            ),
            Effect.scoped,
          ),
      });
    }),
  );
