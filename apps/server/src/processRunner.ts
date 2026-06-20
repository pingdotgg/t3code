import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
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

const ProcessInvocationFields = {
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
  spawnCwd: Schema.optional(Schema.String),
};

const formatProcessInvocation = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
}): string => {
  const command = [input.command, ...input.args].join(" ");
  const executionCwd = input.spawnCwd ?? input.cwd;
  return executionCwd === undefined ? `'${command}'` : `'${command}' in '${executionCwd}'`;
};

export class ProcessSpawnError extends Schema.TaggedErrorClass<ProcessSpawnError>()(
  "ProcessSpawnError",
  {
    ...ProcessInvocationFields,
    resolvedCommand: Schema.optional(Schema.String),
    resolvedArgs: Schema.optional(Schema.Array(Schema.String)),
    shell: Schema.optional(Schema.Boolean),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessStdinError extends Schema.TaggedErrorClass<ProcessStdinError>()(
  "ProcessStdinError",
  {
    ...ProcessInvocationFields,
    stdinBytes: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to write stdin for process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessOutputLimitError extends Schema.TaggedErrorClass<ProcessOutputLimitError>()(
  "ProcessOutputLimitError",
  {
    ...ProcessInvocationFields,
    stream: Schema.Literals(["stdout", "stderr"]),
    maxBytes: Schema.Number,
    observedBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `Process ${formatProcessInvocation(this)} ${this.stream} produced ${this.observedBytes} bytes, exceeding the ${this.maxBytes} byte limit`;
  }
}

export class ProcessReadError extends Schema.TaggedErrorClass<ProcessReadError>()(
  "ProcessReadError",
  {
    ...ProcessInvocationFields,
    stream: Schema.Literals(["stdout", "stderr", "exitCode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.stream} for process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessTimeoutError extends Schema.TaggedErrorClass<ProcessTimeoutError>()(
  "ProcessTimeoutError",
  {
    ...ProcessInvocationFields,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Process ${formatProcessInvocation(this)} timed out after ${this.timeoutMs}ms`;
  }
}

export const ProcessRunError = Schema.Union([
  ProcessSpawnError,
  ProcessStdinError,
  ProcessOutputLimitError,
  ProcessReadError,
  ProcessTimeoutError,
]);
export type ProcessRunError = typeof ProcessRunError.Type;

export class ProcessRunner extends Context.Service<
  ProcessRunner,
  {
    readonly run: (input: ProcessRunInput) => Effect.Effect<ProcessRunOutput, ProcessRunError>;
  }
>()("t3/processRunner") {}

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

export const isWindowsCommandNotFound = Effect.fn("processRunner.isWindowsCommandNotFound")(
  function* (code: number | null, stderr: string) {
    const platform = yield* HostProcessPlatform;
    if (platform !== "win32") return false;
    if (code === 9009) return true;
    return hasWindowsCommandNotFoundMessage(stderr);
  },
);

const collectText = Effect.fn("processRunner.collectText")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
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
          spawnCwd: input.spawnCwd,
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
        if (chunk.byteLength > remainingBytes) {
          return Effect.fail(
            new ProcessOutputLimitError({
              command: input.command,
              args: input.args,
              cwd: input.cwd,
              spawnCwd: input.spawnCwd,
              stream: input.streamName,
              maxBytes: input.maxOutputBytes,
              observedBytes: state.bytes + chunk.byteLength,
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
          spawnCwd: input.spawnCwd,
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
  const extendEnv = input.env !== undefined;
  const spawnCommand = yield* resolveSpawnCommand(
    input.command,
    input.args,
    input.env === undefined ? {} : { env: input.env, extendEnv },
  );

  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...((input.spawnCwd ?? input.cwd) ? { cwd: input.spawnCwd ?? input.cwd } : {}),
        ...(input.env !== undefined
          ? {
              env: input.env,
              extendEnv,
            }
          : {}),
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new ProcessSpawnError({
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            spawnCwd: input.spawnCwd,
            resolvedCommand: spawnCommand.command,
            resolvedArgs: spawnCommand.args,
            shell: spawnCommand.shell,
            cause,
          }),
      ),
    );

  const stdin = input.stdin;
  const writeStdin =
    stdin === undefined
      ? Effect.void
      : Stream.run(Stream.encodeText(Stream.make(stdin)), child.stdin).pipe(
          Effect.mapError(
            (cause) =>
              new ProcessStdinError({
                command: input.command,
                args: input.args,
                cwd: input.cwd,
                spawnCwd: input.spawnCwd,
                stdinBytes: Buffer.byteLength(stdin),
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
        spawnCwd: input.spawnCwd,
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
        spawnCwd: input.spawnCwd,
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
          spawnCwd: input.spawnCwd,
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

export const make = Effect.fn("ProcessRunner.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run: ProcessRunner["Service"]["run"] = (input) =>
    finalizeRunProcess(runProcessCore(spawner, input), input);

  return ProcessRunner.of({
    run,
  });
});

export const layer = Layer.effect(ProcessRunner, make());
