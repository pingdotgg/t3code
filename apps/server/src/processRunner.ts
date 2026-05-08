import { Data, Duration, Effect, Option, PlatformError, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "./stream/collectUint8StreamText.ts";

export interface ProcessRunInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly stdin?: string | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly outputMode?: "error" | "truncate" | undefined;
  readonly truncatedMarker?: string | undefined;
  readonly shell?: boolean | string | undefined;
  /**
   * On timeout, return a synthetic timedOut result.
   * Partial stdout/stderr are not preserved.
   */
  readonly timeoutBehavior?: "error" | "timedOutResult" | undefined;
}

export interface ProcessRunOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export class ProcessSpawnError extends Data.TaggedError("ProcessSpawnError")<{
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly cause: unknown;
}> {}

export class ProcessStdinError extends Data.TaggedError("ProcessStdinError")<{
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly cause: unknown;
}> {}

export class ProcessOutputLimitError extends Data.TaggedError("ProcessOutputLimitError")<{
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly stream: "stdout" | "stderr";
  readonly maxBytes: number;
}> {}

export class ProcessReadError extends Data.TaggedError("ProcessReadError")<{
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly stream: "stdout" | "stderr" | "exitCode";
  readonly cause: unknown;
}> {}

export class ProcessTimeoutError extends Data.TaggedError("ProcessTimeoutError")<{
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly timeoutMs: number;
}> {}

export type ProcessRunError =
  | ProcessSpawnError
  | ProcessStdinError
  | ProcessOutputLimitError
  | ProcessReadError
  | ProcessTimeoutError;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const WINDOWS_COMMAND_NOT_FOUND_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /n.o . reconhecido como um comando interno/i,
  /non . riconosciuto come comando interno o esterno/i,
  /n.est pas reconnu en tant que commande interne/i,
  /no se reconoce como un comando interno o externo/i,
  /wird nicht als interner oder externer befehl/i,
] as const;

function hasWindowsCommandNotFoundMessage(output: string): boolean {
  return WINDOWS_COMMAND_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(output));
}

export function isWindowsCommandNotFound(code: number | null, stderr: string): boolean {
  if (process.platform !== "win32") return false;
  if (code === 9009) return true;
  return hasWindowsCommandNotFoundMessage(stderr);
}

const collectText = Effect.fn("processRunner.collectText")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly streamName: "stdout" | "stderr";
  readonly stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly maxOutputBytes: number;
  readonly outputMode: "error" | "truncate";
  readonly truncatedMarker: string;
}) {
  const result = yield* collectUint8StreamText({
    stream: input.stream.pipe(
      Stream.mapError(
        (cause) =>
          new ProcessReadError({
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            stream: input.streamName,
            cause,
          }),
      ),
    ),
    maxBytes: input.maxOutputBytes,
    truncatedMarker: input.outputMode === "truncate" ? input.truncatedMarker : null,
  });

  if (input.outputMode === "error" && result.truncated) {
    return yield* new ProcessOutputLimitError({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      stream: input.streamName,
      maxBytes: input.maxOutputBytes,
    });
  }

  return result;
});

export const runProcess = Effect.fn("processRunner.runProcess")(
  function* (
    input: ProcessRunInput,
  ): Effect.fn.Return<
    ProcessRunOutput,
    ProcessRunError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  > {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const outputMode = input.outputMode ?? "error";
    const truncatedMarker = input.truncatedMarker ?? "";

    const child = yield* spawner
      .spawn(
        ChildProcess.make(input.command, [...input.args], {
          ...((input.spawnCwd ?? input.cwd)
            ? {
                cwd: input.spawnCwd ?? input.cwd,
              }
            : {}),
          ...(input.env !== undefined
            ? {
                env: input.env,
                extendEnv: true,
              }
            : {}),
          ...(input.shell !== undefined ? { shell: input.shell } : {}),
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProcessSpawnError({
              command: input.command,
              args: input.args,
              cwd: input.cwd,
              cause,
            }),
        ),
      );

    const writeStdin =
      input.stdin === undefined
        ? Effect.void
        : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
            Effect.mapError(
              (cause: PlatformError.PlatformError) =>
                new ProcessStdinError({
                  command: input.command,
                  args: input.args,
                  cwd: input.cwd,
                  cause,
                }),
            ),
          );

    const [stdout, stderr] = yield* Effect.all(
      [
        collectText({
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          streamName: "stdout",
          stream: child.stdout,
          maxOutputBytes,
          outputMode,
          truncatedMarker,
        }),
        collectText({
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          streamName: "stderr",
          stream: child.stderr,
          maxOutputBytes,
          outputMode,
          truncatedMarker,
        }),
        writeStdin,
      ],
      { concurrency: "unbounded" },
    );

    const exitCode = yield* child.exitCode.pipe(
      Effect.mapError(
        (cause: PlatformError.PlatformError) =>
          new ProcessReadError({
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            stream: "exitCode",
            cause,
          }),
      ),
    );

    return {
      stdout: stdout.text,
      stderr: stderr.text,
      code: exitCode,
      timedOut: false,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    } satisfies ProcessRunOutput;
  },
  (effect, input) => {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutBehavior = input.timeoutBehavior ?? "error";

    return effect.pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.flatMap((result) => {
        if (Option.isSome(result)) {
          return Effect.succeed(result.value);
        }
        if (timeoutBehavior === "timedOutResult") {
          return Effect.succeed({
            stdout: "",
            stderr: "",
            code: null,
            timedOut: true,
            stdoutTruncated: false,
            stderrTruncated: false,
          } satisfies ProcessRunOutput);
        }
        return Effect.fail(
          new ProcessTimeoutError({
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            timeoutMs,
          }),
        );
      }),
    );
  },
);
