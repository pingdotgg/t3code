/**
 * Contains props, error tags, and the live service for executing commands.
 * Shared between the `Build`, `Dev`, and `Exec` resources.
 */

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { flow } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { BadArgument, SystemError } from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import { initialCwd } from "../Util/Node.ts";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { ScopedPlanStatusSession } from "../Report.ts";
import { isNonInteractive } from "../Util/interactive.ts";
import {
  makeCommandRedactor,
  redactPlatformReason,
  type CommandRedactor,
} from "./Redaction.ts";

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
   * Entries whose value is `undefined` are dropped — this lets website
   * composites forward optional values (e.g. an `Output` service URL that
   * resolves to `undefined`) without filtering first.
   */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
}

/**
 * Properties shared by finite commands such as {@link Build} and
 * {@link Exec}.
 */
export interface CommandRunProps extends CommandProps {
  /**
   * Maximum time the command may run. When exceeded, Alchemy sends `SIGTERM`
   * to the command's process group, waits a bounded grace period, and then
   * sends `SIGKILL` to ensure no descendants survive.
   *
   * Numbers are interpreted as milliseconds. Effect duration strings and
   * `Duration` values are also accepted.
   *
   * @example "5 minutes"
   */
  timeout?: Duration.Input;
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
      props: CommandRunProps,
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
  reason:
    | SystemError
    | BadArgument
    | UnexpectedExit
    | OutputNotFound
    | CommandTimedOut;
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
 * Represents when a finite command exceeds its configured timeout.
 */
export class CommandTimedOut extends Data.TaggedError("CommandTimedOut")<{
  timeout: string;
}> {
  override get message() {
    return `The command timed out after ${this.timeout}; its process group was terminated.`;
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

/** @internal */
export const makeCommandError = (
  props: Pick<CommandProps, "command" | "env">,
  reason: CommandError["reason"],
): CommandError => {
  const redactor = makeCommandRedactor(props.env);
  const safeReason =
    reason instanceof BadArgument || reason instanceof SystemError
      ? redactPlatformReason(reason, redactor)
      : reason._tag === "UnexpectedExit"
        ? new UnexpectedExit({
            exitCode: reason.exitCode,
            stderr: redactor.redact(reason.stderr),
          })
        : reason._tag === "OutputNotFound"
          ? new OutputNotFound({ outdir: redactor.redact(reason.outdir) })
          : new CommandTimedOut({
              timeout: redactor.redact(reason.timeout),
            });

  return new CommandError({
    command: redactor.redact(props.command),
    reason: safeReason,
  });
};

const TERMINATION_GRACE_PERIOD = Duration.seconds(1);
const TERMINATION_SIGNAL_DISPATCH_TIMEOUT = Duration.millis(25);

const parseExecutionTimeout = (
  props: CommandRunProps,
): Effect.Effect<Duration.Duration | undefined, CommandError> => {
  if (props.timeout === undefined) return Effect.succeed(undefined);
  const decoded = Duration.fromInput(props.timeout);
  if (
    Option.isNone(decoded) ||
    !Duration.isFinite(decoded.value) ||
    Duration.isZero(decoded.value) ||
    Duration.isNegative(decoded.value)
  ) {
    return Effect.fail(
      makeCommandError(
        props,
        new BadArgument({
          module: "Command",
          method: "run",
          description: "timeout must be a positive finite duration",
        }),
      ),
    );
  }
  return Effect.succeed(decoded.value);
};

const terminateProcessGroup = (child: ChildProcessSpawner.ChildProcessHandle) =>
  Effect.gen(function* () {
    // Dispatch SIGTERM without waiting indefinitely for the root process. The
    // Effect process runtime targets the detached process group on POSIX and
    // the full process tree on Windows.
    yield* child
      .kill({ killSignal: "SIGTERM" })
      .pipe(
        Effect.timeoutOption(TERMINATION_SIGNAL_DISPATCH_TIMEOUT),
        Effect.ignore,
      );
    yield* Effect.sleep(TERMINATION_GRACE_PERIOD);

    // Always signal the group again: the root may have exited promptly while
    // a descendant ignored SIGTERM. The hard-kill wait is itself bounded.
    yield* child
      .kill({ killSignal: "SIGKILL" })
      .pipe(Effect.timeoutOption(TERMINATION_GRACE_PERIOD), Effect.ignore);
  });

const redactChildProcessHandle = (
  child: ChildProcessSpawner.ChildProcessHandle,
  redactor: CommandRedactor,
): ChildProcessSpawner.ChildProcessHandle => {
  const stdout = child.stdout.pipe(
    Stream.decodeText,
    redactor.stream,
    Stream.encodeText,
  );
  const stderr = child.stderr.pipe(
    Stream.decodeText,
    redactor.stream,
    Stream.encodeText,
  );
  return ChildProcessSpawner.makeHandle({
    pid: child.pid,
    exitCode: child.exitCode,
    isRunning: child.isRunning,
    kill: child.kill,
    stdin: child.stdin,
    stdout,
    stderr,
    all: Stream.merge(stdout, stderr),
    getInputFd: child.getInputFd,
    getOutputFd: child.getOutputFd,
    unref: child.unref,
  });
};

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
            makeCommandError(
              props,
              new BadArgument({
                module: "Command",
                method: "parseCommand",
                description: "Command is empty",
              }),
            ),
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
                // Anchored: a live `process.cwd()` read can race a
                // concurrent tool's transient chdir (see Util/Node.ts).
                cwd: path.resolve(initialCwd, props.cwd ?? "."),
                shell: props.shell ?? false,
                env: Object.fromEntries(
                  Object.entries(props.env ?? {})
                    .filter(
                      (
                        entry,
                      ): entry is [
                        string,
                        string | Redacted.Redacted<string>,
                      ] => entry[1] !== undefined,
                    )
                    .map(([k, v]) => [
                      k,
                      Redacted.isRedacted(v) ? Redacted.value(v) : v,
                    ]),
                ),
                extendEnv: true,
                stdin: isNonInteractive() ? "ignore" : "inherit",
                stdout: "pipe",
                stderr: "pipe",
                // The Effect process runtime creates a detached process group
                // by default on POSIX. Preserve that default so timeouts and
                // scoped interruption can terminate every descendant.
                killSignal: "SIGKILL",
              }),
            ),
          ),
          Effect.map((child) =>
            redactChildProcessHandle(child, makeCommandRedactor(props.env)),
          ),
          mapError(props),
        );

      /** Collects the output of a stream, tapping each line to a sink. */
      const collect = (
        stream: Stream.Stream<Uint8Array, PlatformError>,
        tap: (chunk: string) => Effect.Effect<void>,
        redactor: CommandRedactor,
      ) =>
        stream.pipe(
          Stream.decodeText,
          redactor.stream,
          Stream.tapSink(
            Sink.make<string>()(
              flow(Stream.splitLines, Stream.runForEach(tap)),
            ),
          ),
          Stream.mkString,
        );

      /** Maps a PlatformError to a CommandError. */
      const mapError = (props: CommandProps) =>
        Effect.mapError((error: PlatformError | CommandError) =>
          error._tag === "CommandError"
            ? error
            : makeCommandError(props, error.reason),
        );

      return CommandExecutor.of({
        spawn,
        /** Executes a command, returning the exit code, stdout, and stderr. */
        run: (props: CommandRunProps, session: ScopedPlanStatusSession) =>
          Effect.gen(function* () {
            const timeout = yield* parseExecutionTimeout(props);
            const redactor = makeCommandRedactor(props.env);
            const child = yield* spawn(props);
            const execution = Effect.all(
              {
                exitCode: child.exitCode,
                stdout: collect(
                  child.stdout,
                  (line) => session.note(line, { kind: "output" }),
                  redactor,
                ),
                stderr: collect(
                  child.stderr,
                  (line) => session.note(line, { kind: "output" }),
                  redactor,
                ),
              },
              { concurrency: "unbounded" },
            ).pipe(mapError(props));

            const result =
              timeout === undefined
                ? yield* execution
                : yield* Effect.gen(function* () {
                    const fiber = yield* Effect.forkScoped(execution);
                    const completed = yield* Fiber.join(fiber).pipe(
                      Effect.timeoutOption(timeout),
                    );
                    if (Option.isSome(completed)) return completed.value;

                    yield* terminateProcessGroup(child);
                    yield* Fiber.interrupt(fiber).pipe(
                      Effect.timeoutOption(TERMINATION_GRACE_PERIOD),
                      Effect.ignore,
                    );
                    return yield* Effect.fail(
                      makeCommandError(
                        props,
                        new CommandTimedOut({
                          timeout: Duration.format(timeout),
                        }),
                      ),
                    );
                  });

            if (result.exitCode !== 0) {
              return yield* Effect.fail(
                makeCommandError(
                  props,
                  new UnexpectedExit({
                    exitCode: result.exitCode,
                    stderr: result.stderr,
                  }),
                ),
              );
            }
            return result;
          }).pipe(Effect.scoped),
      });
    }),
  );
