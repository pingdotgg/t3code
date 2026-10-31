// Pi frames are LF-delimited with trailing CR stripped; readline also splits U+2028/U+2029 and corrupts them.
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  MAX_TOOL_OUTPUT_IMAGES,
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
} from "@t3tools/shared/toolOutput";

import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";

export class PiRpcError extends Schema.TaggedError<PiRpcError>()("PiRpcError", {
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Pi RPC ${this.operation} failed${this.detail === undefined ? "" : `: ${this.detail}`}.`;
  }
}

export class PiRpcTimeoutError extends Schema.TaggedError<PiRpcTimeoutError>()(
  "PiRpcTimeoutError",
  {
    operation: Schema.String,
    timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  },
) {
  override get message(): string {
    return `Pi RPC ${this.operation} failed: timed out after ${this.timeoutMs}ms.`;
  }
}

export type PiRpcRecord = Record<string, unknown>;

export function piRecordField(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}

export function piRecordString(input: unknown, key: string): string | undefined {
  const value = piRecordField(input, key);
  return Predicate.isString(value) ? value : undefined;
}

export function piRecordNumber(input: unknown, key: string): number | undefined {
  const value = piRecordField(input, key);
  return Predicate.isNumber(value) && Number.isFinite(value) ? value : undefined;
}

export function parsePiModelSlug(slug: string): { provider: string; modelId: string } | null {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return null;
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

export interface PiRpcSpawnOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

export interface PiRpcConnection {
  readonly send: (record: PiRpcRecord) => Effect.Effect<void, PiRpcError>;
  readonly request: (
    record: PiRpcRecord,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, PiRpcError | PiRpcTimeoutError>;
  readonly events: Queue.Queue<PiRpcRecord, PiRpcError>;
  readonly exited: Effect.Effect<number, PiRpcError>;
  readonly terminate: Effect.Effect<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE = Duration.seconds(1);

interface PendingPiRequest {
  readonly deferred: Deferred.Deferred<unknown, PiRpcError>;
}

// MCP duplicates images in model content and CallToolResult; budget both plus bounded overhead.
const MAX_PI_RECORD_CHARS =
  2 * MAX_TOOL_OUTPUT_IMAGES * MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH + 8 * 1024 * 1024;

function makeJsonlFramer() {
  let buffer = "";
  let dropping = false;
  return (chunk: string): ReadonlyArray<string> => {
    const lines: string[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      if (!dropping) {
        if (buffer.length + end - start > MAX_PI_RECORD_CHARS) {
          buffer = "";
          dropping = true;
        } else {
          buffer += chunk.slice(start, end);
        }
      }
      if (newline < 0) break;
      if (!dropping && buffer.length > 0) {
        lines.push(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      }
      buffer = "";
      dropping = false;
      start = newline + 1;
    }
    return lines;
  };
}

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJsonLine = Schema.decodeSync(UnknownFromJsonString);
const encodeJsonLine = Schema.encodeSync(UnknownFromJsonString);

const PI_ERROR_DETAIL_MAX_CHARS = 200;

function summarizePiError(error: unknown): string {
  const text = typeof error === "string" ? error : JSON.stringify(error);
  if (text === undefined) return "unknown error";
  return text.length > PI_ERROR_DETAIL_MAX_CHARS
    ? `${text.slice(0, PI_ERROR_DETAIL_MAX_CHARS)}…`
    : text;
}

// Pi 0.84+ may exit 1 during import without any protocol output.
function describePiStdoutClosure(exitCode: number | undefined): string {
  if (exitCode === undefined || !Number.isFinite(exitCode)) {
    return "pi process closed stdout";
  }
  return `pi process exited with code ${exitCode}`;
}

function parsePiRecord(line: string): PiRpcRecord | undefined {
  try {
    const parsed: unknown = decodeJsonLine(line);
    return Predicate.isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `hasExited` is consulted before each signal. Once the original child is
 * gone its pid/pgid can be recycled by the OS, so escalating blindly could
 * deliver SIGKILL to an unrelated process.
 */
const terminatePiProcess = Effect.fn("PiRpc.terminatePiProcess")(function* (
  kill: (signal: NodeJS.Signals) => boolean,
  hasExited: () => boolean,
) {
  if (hasExited()) return;
  if (!kill("SIGTERM")) return;
  yield* Effect.sleep(TERMINATION_GRACE);
  if (hasExited()) return;
  kill("SIGKILL");
});

export const makePiRpcConnection = Effect.fnUntraced(function* (options: PiRpcSpawnOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const scope = yield* Effect.scope;

  const spawnCommand = yield* resolveSpawnCommand(options.command, [...options.args], {
    env: options.env,
  }).pipe(Effect.mapError((cause) => new PiRpcError({ operation: "spawn", cause })));
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env,
        extendEnv: false,
        shell: spawnCommand.shell,
        detached: platform !== "win32",
      }),
    )
    .pipe(Effect.mapError((cause) => new PiRpcError({ operation: "spawn", cause })));

  let childExited = false;
  let diagnosingStdoutClose = false;

  const killProcessGroup = (signal: NodeJS.Signals): boolean => {
    try {
      if (platform === "win32") {
        process.kill(Number(child.pid), signal);
      } else {
        signalProcessGroup(Number(child.pid), signal);
      }
      return true;
    } catch {
      return false;
    }
  };

  const hasExited = (): boolean => {
    if (childExited) return true;
    try {
      if (platform === "win32") process.kill(Number(child.pid), 0);
      else signalProcessGroup(Number(child.pid), 0);
      return false;
    } catch {
      return true;
    }
  };

  // Windows process.kill leaves extension children and pipes alive; taskkill /T reaps the tree.
  const terminateWindowsTree = Effect.gen(function* () {
    if (hasExited()) return;
    const taskkill = yield* spawner.spawn(
      ChildProcess.make("taskkill", ["/PID", String(child.pid), "/T", "/F"]),
    );
    yield* taskkill.exitCode;
  }).pipe(Effect.scoped, Effect.ignore);

  const terminateProcess =
    platform === "win32" ? terminateWindowsTree : terminatePiProcess(killProcessGroup, hasExited);

  // Register teardown immediately after spawn so interrupted setup cannot leak a detached process.
  yield* Scope.addFinalizer(scope, terminateProcess.pipe(Effect.ignore, Effect.uninterruptible));

  const pendingRequests = new Map<string, PendingPiRequest>();
  const events = yield* Queue.unbounded<PiRpcRecord, PiRpcError>();
  const outgoing = yield* Queue.unbounded<Uint8Array, PiRpcError>();
  const transportDown = yield* Deferred.make<never, PiRpcError>();
  const exitDeferred = yield* Deferred.make<number, PiRpcError>();
  let nextRequestId = 0;

  const failTransport = Effect.fn("PiRpc.failTransport")(function* (error: PiRpcError) {
    const claimed = yield* Deferred.fail(transportDown, error);
    if (!claimed) return;
    for (const [key, pending] of pendingRequests) {
      pendingRequests.delete(key);
      yield* Deferred.fail(pending.deferred, error);
    }
    yield* Queue.fail(outgoing, error);
    yield* Queue.fail(events, error);
  });

  const routeRecord =
    /* Protocol records and writes include streaming deltas; avoid a span per record. */
    Effect.fnUntraced(function* (record: PiRpcRecord) {
      if (record["type"] === "response" && typeof record["id"] === "string") {
        const pending = pendingRequests.get(record["id"]);
        if (pending !== undefined) {
          pendingRequests.delete(record["id"]);
          if (record["success"] === true) {
            yield* Deferred.succeed(pending.deferred, record["data"]);
          } else {
            yield* Deferred.fail(
              pending.deferred,
              new PiRpcError({
                operation: String(record["command"] ?? "request"),
                detail: summarizePiError(record["error"]),
                ...(record["error"] === undefined ? {} : { cause: record["error"] }),
              }),
            );
          }
          return;
        }
      }
      yield* Queue.offer(events, record);
    });

  // Watch exit before reading stdout so immediate crashes populate exitDeferred for diagnosis.
  yield* child.exitCode.pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        Deferred.fail(exitDeferred, new PiRpcError({ operation: "exit", cause })),
      onSuccess: (code) =>
        Effect.suspend(() => {
          childExited = true;
          return Deferred.succeed(exitDeferred, Number(code));
        }),
    }),
    Effect.forkIn(scope),
  );

  yield* Effect.gen(function* () {
    const frame = makeJsonlFramer();
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const lines = frame(chunk);
          for (const line of lines) {
            const record = parsePiRecord(line);
            if (record === undefined) {
              yield* Effect.logDebug("Dropping non-JSON pi stdout line.", {
                lineLength: line.length,
              });
              continue;
            }
            yield* routeRecord(record);
          }
        }),
      ),
    );
    for (const line of frame("\n")) {
      const trailing = parsePiRecord(line);
      if (trailing !== undefined) yield* routeRecord(trailing);
    }
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => failTransport(new PiRpcError({ operation: "read", cause })),
      // The enclosing operation owns the span for this inline handler.
      onSuccess: Effect.fnUntraced(function* () {
        // Claim stdout-close diagnosis before waiting so broken stdin cannot replace the exit error.
        diagnosingStdoutClose = true;
        const polled = yield* Deferred.poll(exitDeferred);
        const maybeExitCode = Option.isSome(polled)
          ? yield* polled.value.pipe(
              Effect.asSome,
              Effect.orElseSucceed(() => Option.none<number>()),
            )
          : yield* Deferred.await(exitDeferred).pipe(
              Effect.timeoutOption(Duration.millis(250)),
              // Stdout-close waits need wall time; TestClock would strand Stop-with-restart without an exit.
              Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
              Effect.orElseSucceed(() => Option.none<number>()),
            );
        return yield* failTransport(
          new PiRpcError({
            operation: "read",
            detail: describePiStdoutClosure(
              Option.isSome(maybeExitCode) ? maybeExitCode.value : undefined,
            ),
          }),
        );
      }),
    }),
    Effect.forkIn(scope),
  );

  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      chunk.trim().length === 0
        ? Effect.void
        : // Log stderr length only; unbounded text may contain credentials or prompts.
          Effect.logDebug("pi stderr", { stderrLength: chunk.length }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  // Start the reader first so stdout-close diagnosis can win over broken-pipe stdin.
  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.catchCause((cause) =>
      diagnosingStdoutClose
        ? Effect.void
        : failTransport(new PiRpcError({ operation: "write", cause })),
    ),
    Effect.forkIn(scope),
  );

  const send =
    /* Protocol records and writes include streaming deltas; avoid a span per record. */
    Effect.fnUntraced(function* (record: PiRpcRecord): Effect.fn.Return<void, PiRpcError> {
      const accepted = yield* Queue.offer(
        outgoing,
        new TextEncoder().encode(`${encodeJsonLine(record)}\n`),
      );
      if (!accepted) {
        return yield* Deferred.await(transportDown);
      }
    });

  const request = Effect.fn("PiRpc.request")(function* (
    record: PiRpcRecord,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Effect.fn.Return<unknown, PiRpcError | PiRpcTimeoutError> {
    const id = `t3-${nextRequestId++}`;
    const deferred = yield* Deferred.make<unknown, PiRpcError>();
    pendingRequests.set(id, { deferred });
    yield* send({ ...record, id }).pipe(
      Effect.tapError(() => Effect.sync(() => pendingRequests.delete(id))),
    );
    return yield* Effect.raceFirst(Deferred.await(deferred), Deferred.await(transportDown)).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () =>
          Effect.fail(
            new PiRpcTimeoutError({
              operation: String(record["type"] ?? "request"),
              timeoutMs,
            }),
          ),
      }),
      Effect.onInterrupt(() => Effect.sync(() => pendingRequests.delete(id))),
      Effect.onError(() => Effect.sync(() => pendingRequests.delete(id))),
    );
  });

  return {
    send,
    request,
    events,
    exited: Deferred.await(exitDeferred),
    terminate: failTransport(
      new PiRpcError({ operation: "terminate", detail: "pi process was stopped" }),
    ).pipe(Effect.andThen(terminateProcess), Effect.ignore, Effect.uninterruptible),
  } satisfies PiRpcConnection;
});
