import * as Data from "effect/Data";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  collectUint8StreamText,
  type CollectedUint8StreamText,
} from "./stream/collectUint8StreamText.ts";

export interface ProcessRunInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
  readonly timeout?: Duration.Input | undefined;
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
  readonly code: ChildProcessSpawner.ExitCode | null;
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

export interface ProcessRunnerShape {
  readonly run: (input: ProcessRunInput) => Effect.Effect<ProcessRunOutput, ProcessRunError>;
}

export class ProcessRunner extends Context.Service<ProcessRunner, ProcessRunnerShape>()(
  "t3/process/ProcessRunner",
) {}

const DEFAULT_TIMEOUT = "60 seconds";
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
  const stream = input.stream.pipe(
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
  );

  if (input.outputMode === "truncate") {
    return yield* collectUint8StreamText({
      stream,
      maxBytes: input.maxOutputBytes,
      truncatedMarker: input.truncatedMarker,
    });
  }

  return yield* stream.pipe(
    Stream.runFoldEffect<
      {
        readonly chunks: Uint8Array<ArrayBufferLike>[];
        readonly bytes: number;
      },
      Uint8Array<ArrayBufferLike>,
      ProcessOutputLimitError | ProcessReadError,
      never
    >(
      () => ({ chunks: [], bytes: 0 }),
      (state, chunk) => {
        const remainingBytes = input.maxOutputBytes - state.bytes;
        if (remainingBytes <= 0 || chunk.byteLength > remainingBytes) {
          return Effect.fail(
            new ProcessOutputLimitError({
              command: input.command,
              args: input.args,
              cwd: input.cwd,
              stream: input.streamName,
              maxBytes: input.maxOutputBytes,
            }),
          );
        }

        state.chunks.push(chunk);
        return Effect.succeed({
          chunks: state.chunks,
          bytes: state.bytes + chunk.byteLength,
        });
      },
    ),
    Effect.map(
      (state): CollectedUint8StreamText => ({
        text: Buffer.concat(state.chunks, state.bytes).toString("utf8"),
        bytes: state.bytes,
        truncated: false,
      }),
    ),
  );
});

function finalizeRunProcess<R>(
  effect: Effect.Effect<ProcessRunOutput, ProcessRunError, R | Scope.Scope>,
  input: ProcessRunInput,
): Effect.Effect<ProcessRunOutput, ProcessRunError, Exclude<R, Scope.Scope>> {
  const timeout = Duration.fromInputUnsafe(input.timeout ?? DEFAULT_TIMEOUT);
  const timeoutBehavior = input.timeoutBehavior ?? "error";

  return effect.pipe(
    Effect.scoped,
    Effect.timeoutOption(timeout),
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
          timeoutMs: Duration.toMillis(timeout),
        }),
      );
    }),
  );
}

const runProcessCore = Effect.fn("processRunner.runProcessCore")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: ProcessRunInput,
): Effect.fn.Return<ProcessRunOutput, ProcessRunError, Scope.Scope> {
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const outputMode = input.outputMode ?? "error";
  const truncatedMarker = input.truncatedMarker ?? "";

  const child = yield* spawner
    .spawn(
      ChildProcess.make(input.command, [...input.args], {
        ...((input.spawnCwd ?? input.cwd) ? { cwd: input.spawnCwd ?? input.cwd } : {}),
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
            (cause) =>
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
      (cause) =>
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
});

export const make = Effect.fn("makeProcessRunner")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run: ProcessRunnerShape["run"] = (input) =>
    finalizeRunProcess(runProcessCore(spawner, input), input);

  return ProcessRunner.of({
    run,
  });
});

export const layer = Layer.effect(ProcessRunner, make());
