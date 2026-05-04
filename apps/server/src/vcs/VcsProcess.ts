import { Duration, Context, Effect, Layer, Option, PlatformError, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  VcsOutputDecodeError,
  type VcsError,
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";

export interface VcsProcessInput {
  readonly operation: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly truncateOutputAtMaxBytes?: boolean;
}

export interface VcsProcessOutput {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface VcsProcessCollectedText {
  readonly text: string;
  readonly truncated: boolean;
}

export interface VcsProcessHandle {
  readonly pid: ChildProcessSpawner.ProcessId;
  readonly stdin: Sink.Sink<void, Uint8Array, never, VcsError>;
  readonly stdout: Stream.Stream<Uint8Array, VcsError>;
  readonly stderr: Stream.Stream<Uint8Array, VcsError>;
  readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode, VcsError>;
  readonly writeStdin: (input: string) => Effect.Effect<void, VcsError>;
}

export interface VcsProcessShape {
  readonly withProcess: <A, E, R>(
    input: VcsProcessInput,
    use: (handle: VcsProcessHandle) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | VcsError, R>;
  readonly run: (input: VcsProcessInput) => Effect.Effect<VcsProcessOutput, VcsError>;
}

export class VcsProcess extends Context.Service<VcsProcess, VcsProcessShape>()(
  "t3/vcs/VcsProcess",
) {}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

function commandLabel(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].join(" ");
}

function outputDecodeError(
  input: VcsProcessInput,
  detail: string,
  cause: unknown,
): VcsOutputDecodeError {
  return new VcsOutputDecodeError({
    operation: input.operation,
    command: commandLabel(input.command, input.args),
    cwd: input.cwd,
    detail,
    cause,
  });
}

export const collectText = Effect.fn("VcsProcess.collectText")(function* (input: {
  readonly operation: string;
  readonly command: string;
  readonly cwd: string;
  readonly stream: Stream.Stream<Uint8Array, VcsError>;
  readonly maxOutputBytes?: number;
  readonly truncateOutputAtMaxBytes?: boolean;
}) {
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const truncateOutputAtMaxBytes = input.truncateOutputAtMaxBytes ?? false;

  yield* Stream.runForEach(input.stream, (chunk) =>
    Effect.sync(() => {
      if (truncated) return;

      const remainingBytes = maxOutputBytes - bytes;
      if (remainingBytes <= 0) {
        truncated = true;
        if (truncateOutputAtMaxBytes) {
          text += OUTPUT_TRUNCATED_MARKER;
        }
        return;
      }

      const nextChunk = chunk.byteLength > remainingBytes ? chunk.slice(0, remainingBytes) : chunk;
      text += decoder.decode(nextChunk, { stream: true });
      bytes += nextChunk.byteLength;

      if (chunk.byteLength > remainingBytes) {
        truncated = true;
        if (truncateOutputAtMaxBytes) {
          text += OUTPUT_TRUNCATED_MARKER;
        }
      }
    }),
  );

  if (!truncated) {
    text += decoder.decode();
  }

  return { text, truncated } satisfies VcsProcessCollectedText;
});

export const make = Effect.fn("makeVcsProcess")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const spawn = Effect.fn("VcsProcess.spawn")(function* (input: VcsProcessInput) {
    const label = commandLabel(input.command, input.args);
    const child = yield* spawner
      .spawn(
        ChildProcess.make(input.command, [...input.args], {
          cwd: input.cwd,
          env: {
            ...process.env,
            ...input.env,
          },
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new VcsProcessSpawnError({
              operation: input.operation,
              command: label,
              cwd: input.cwd,
              cause,
            }),
        ),
      );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));

    const mapStreamError = (streamName: "stdout" | "stderr") =>
      Stream.mapError((cause: PlatformError.PlatformError) =>
        outputDecodeError(input, `failed to read process ${streamName}`, cause),
      );
    const mapEffectError = (detail: string) =>
      Effect.mapError((cause: PlatformError.PlatformError) =>
        outputDecodeError(input, detail, cause),
      );
    const writeStdin = (stdin: string) =>
      Stream.run(Stream.encodeText(Stream.make(stdin)), child.stdin).pipe(
        mapEffectError("failed to write process stdin"),
      );

    return {
      pid: child.pid,
      stdin: child.stdin.pipe(
        Sink.mapError((cause) => outputDecodeError(input, "failed to write process stdin", cause)),
      ),
      stdout: child.stdout.pipe(mapStreamError("stdout")),
      stderr: child.stderr.pipe(mapStreamError("stderr")),
      exitCode: child.exitCode.pipe(mapEffectError("failed to read process exit code")),
      writeStdin,
    } satisfies VcsProcessHandle;
  });

  const withProcess: VcsProcessShape["withProcess"] = (input, use) =>
    Effect.scoped(spawn(input).pipe(Effect.flatMap(use)));

  const run = Effect.fn("VcsProcess.run")(function* (input: VcsProcessInput) {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const label = commandLabel(input.command, input.args);

    const runProcess = Effect.gen(function* () {
      const [stdout, stderr, exitCode] = yield* withProcess(input, (child) =>
        Effect.all(
          [
            collectText({
              operation: input.operation,
              command: label,
              cwd: input.cwd,
              stream: child.stdout,
              maxOutputBytes,
              truncateOutputAtMaxBytes: input.truncateOutputAtMaxBytes ?? false,
            }),
            collectText({
              operation: input.operation,
              command: label,
              cwd: input.cwd,
              stream: child.stderr,
              maxOutputBytes,
              truncateOutputAtMaxBytes: input.truncateOutputAtMaxBytes ?? false,
            }),
            child.exitCode,
            input.stdin === undefined ? Effect.void : child.writeStdin(input.stdin),
          ],
          { concurrency: "unbounded" },
        ),
      ).pipe(Effect.map(([stdout, stderr, exitCode]) => [stdout, stderr, exitCode] as const));

      if (!input.allowNonZeroExit && exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: input.operation,
          command: label,
          cwd: input.cwd,
          exitCode,
          detail: stderr.text.trim() || `${label} exited with code ${exitCode}.`,
        });
      }

      return {
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      } satisfies VcsProcessOutput;
    });

    return yield* runProcess.pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.flatMap((result) =>
        Option.match(result, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              new VcsProcessTimeoutError({
                operation: input.operation,
                command: label,
                cwd: input.cwd,
                timeoutMs,
              }),
            ),
        }),
      ),
    );
  });

  return VcsProcess.of({ withProcess, run });
});

export const layer = Layer.effect(VcsProcess, make());
