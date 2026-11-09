// ZCode app-server speaks NDJSON on stdio; responses carry {id, result|error} while server→client
// requests repeat the {id, method, params} shape and must be answered via respond().
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

import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";

export class ZcodeProtocolError extends Schema.TaggedError<ZcodeProtocolError>()(
  "ZcodeProtocolError",
  {
    operation: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `ZCode protocol ${this.operation} failed${this.detail === undefined ? "" : `: ${this.detail}`}.`;
  }
}

export class ZcodeProtocolTimeoutError extends Schema.TaggedError<ZcodeProtocolTimeoutError>()(
  "ZcodeProtocolTimeoutError",
  {
    operation: Schema.String,
    timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  },
) {
  override get message(): string {
    return `ZCode protocol ${this.operation} failed: timed out after ${this.timeoutMs}ms.`;
  }
}

export type ZcodeRecord = Record<string, unknown>;

export function zcodeRecordField(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}

export function zcodeRecordString(input: unknown, key: string): string | undefined {
  const value = zcodeRecordField(input, key);
  return Predicate.isString(value) ? value : undefined;
}

export function zcodeRecordNumber(input: unknown, key: string): number | undefined {
  const value = zcodeRecordField(input, key);
  return Predicate.isNumber(value) && Number.isFinite(value) ? value : undefined;
}

export function zcodeRecordArray(input: unknown, key: string): ReadonlyArray<unknown> | undefined {
  const value = zcodeRecordField(input, key);
  return Array.isArray(value) ? value : undefined;
}

export const isServerRequest = (record: ZcodeRecord): boolean =>
  record["id"] !== undefined && Predicate.isString(record["method"]);

export interface ZcodeSpawnOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

export interface ZcodeConnection {
  readonly request: (
    method: string,
    params: ZcodeRecord,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, ZcodeProtocolError | ZcodeProtocolTimeoutError>;
  readonly respond: (id: string, result: unknown) => Effect.Effect<void, ZcodeProtocolError>;
  readonly events: Queue.Queue<ZcodeRecord, ZcodeProtocolError>;
  readonly exited: Effect.Effect<number, ZcodeProtocolError>;
  readonly terminate: Effect.Effect<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE = Duration.seconds(1);

interface PendingZcodeRequest {
  readonly deferred: Deferred.Deferred<unknown, ZcodeProtocolError>;
}

const MAX_ZCODE_RECORD_CHARS = 16 * 1024 * 1024;

function makeJsonlFramer() {
  let buffer = "";
  let dropping = false;
  return (chunk: string) => {
    const lines: string[] = [];
    const droppedLengths: number[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      if (!dropping) {
        if (buffer.length + end - start > MAX_ZCODE_RECORD_CHARS) {
          droppedLengths.push(buffer.length + end - start);
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
    return { lines, droppedLengths };
  };
}

const logDroppedZcodeRecords = (droppedLengths: ReadonlyArray<number>) =>
  Effect.forEach(
    droppedLengths,
    (recordLength) =>
      Effect.logWarning("Dropping oversized zcode stdout record.", {
        recordLength,
        maxRecordLength: MAX_ZCODE_RECORD_CHARS,
      }),
    { discard: true },
  );

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJsonLine = Schema.decodeSync(UnknownFromJsonString);
const encodeJsonLine = Schema.encodeSync(UnknownFromJsonString);

/** JSON text for wire params/diagnostics; pure, so it may fall back to an empty string. */
export function zcodeJsonStringify(value: unknown): string {
  try {
    return encodeJsonLine(value);
  } catch {
    return "";
  }
}

const ZCODE_ERROR_DETAIL_MAX_CHARS = 600;

function summarizeZcodeError(error: unknown): string {
  const text = typeof error === "string" ? error : JSON.stringify(error);
  if (text === undefined) return "unknown error";
  return text.length > ZCODE_ERROR_DETAIL_MAX_CHARS
    ? `${text.slice(0, ZCODE_ERROR_DETAIL_MAX_CHARS)}…`
    : text;
}

function describeZcodeStdoutClosure(exitCode: number | undefined): string {
  if (exitCode === undefined || !Number.isFinite(exitCode)) {
    return "zcode app-server closed stdout";
  }
  return `zcode app-server exited with code ${exitCode}`;
}

function parseZcodeRecord(line: string): ZcodeRecord | undefined {
  try {
    const parsed: unknown = decodeJsonLine(line);
    return Predicate.isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const terminateZcodeProcess = Effect.fn("ZcodeProtocol.terminateZcodeProcess")(function* (
  kill: (signal: NodeJS.Signals) => boolean,
  hasExited: () => boolean,
) {
  if (hasExited()) return;
  if (!kill("SIGTERM")) return;
  yield* Effect.sleep(TERMINATION_GRACE);
  if (hasExited()) return;
  kill("SIGKILL");
});

export const makeZcodeConnection = Effect.fnUntraced(function* (options: ZcodeSpawnOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const scope = yield* Effect.scope;

  const spawnCommand = yield* resolveSpawnCommand(options.command, [...options.args], {
    env: options.env,
  }).pipe(Effect.mapError((cause) => new ZcodeProtocolError({ operation: "spawn", cause })));
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env,
        extendEnv: false,
        shell: spawnCommand.shell,
        detached: platform !== "win32",
        stdin: { stream: "pipe", endOnDone: false },
      }),
    )
    .pipe(Effect.mapError((cause) => new ZcodeProtocolError({ operation: "spawn", cause })));

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

  const terminateWindowsTree = Effect.gen(function* () {
    if (hasExited()) return;
    const taskkill = yield* spawner.spawn(
      ChildProcess.make("taskkill", ["/PID", String(child.pid), "/T", "/F"]),
    );
    yield* taskkill.exitCode;
  }).pipe(Effect.scoped, Effect.ignore);

  const terminateProcess =
    platform === "win32"
      ? terminateWindowsTree
      : terminateZcodeProcess(killProcessGroup, hasExited);

  yield* Scope.addFinalizer(scope, terminateProcess.pipe(Effect.ignore, Effect.uninterruptible));

  const pendingRequests = new Map<string, PendingZcodeRequest>();
  const events = yield* Queue.unbounded<ZcodeRecord, ZcodeProtocolError>();
  const outgoing = yield* Queue.unbounded<Uint8Array, ZcodeProtocolError>();
  const transportDown = yield* Deferred.make<never, ZcodeProtocolError>();
  const exitDeferred = yield* Deferred.make<number, ZcodeProtocolError>();
  let nextRequestId = 1;

  const failTransport = Effect.fn("ZcodeProtocol.failTransport")(function* (
    error: ZcodeProtocolError,
  ) {
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
    /* Streaming deltas ride through here; avoid a span per record. */
    Effect.fnUntraced(function* (record: ZcodeRecord) {
      if (isServerRequest(record)) {
        // Server→client requests are surfaced as events; the adapter answers via respond().
        yield* Queue.offer(events, record);
        return;
      }
      if (record["id"] !== undefined) {
        const key = String(record["id"]);
        const pending = pendingRequests.get(key);
        if (pending !== undefined) {
          pendingRequests.delete(key);
          if (record["error"] === undefined) {
            yield* Deferred.succeed(pending.deferred, record["result"]);
          } else {
            yield* Deferred.fail(
              pending.deferred,
              new ZcodeProtocolError({
                operation: String(record["method"] ?? "request"),
                detail: summarizeZcodeError(record["error"]),
                ...(record["error"] === undefined ? {} : { cause: record["error"] }),
              }),
            );
          }
          return;
        }
      }
      yield* Queue.offer(events, record);
    });

  yield* child.exitCode.pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        Deferred.fail(exitDeferred, new ZcodeProtocolError({ operation: "exit", cause })),
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
          const { lines, droppedLengths } = frame(chunk);
          yield* logDroppedZcodeRecords(droppedLengths);
          for (const line of lines) {
            const record = parseZcodeRecord(line);
            if (record === undefined) {
              yield* Effect.logDebug("Dropping non-JSON zcode stdout line.", {
                lineLength: line.length,
              });
              continue;
            }
            yield* routeRecord(record);
          }
        }),
      ),
    );
    const flushed = frame("\n");
    yield* logDroppedZcodeRecords(flushed.droppedLengths);
    for (const line of flushed.lines) {
      const trailing = parseZcodeRecord(line);
      if (trailing !== undefined) yield* routeRecord(trailing);
    }
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => failTransport(new ZcodeProtocolError({ operation: "read", cause })),
      onSuccess: Effect.fnUntraced(function* () {
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
          new ZcodeProtocolError({
            operation: "read",
            detail: describeZcodeStdoutClosure(
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
        : Effect.logDebug("zcode app-server stderr", { stderrLength: chunk.length }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.catchCause((cause) =>
      diagnosingStdoutClose
        ? Effect.void
        : failTransport(new ZcodeProtocolError({ operation: "write", cause })),
    ),
    Effect.forkIn(scope),
  );

  const send =
    /* Streaming deltas ride through here; avoid a span per record. */
    Effect.fnUntraced(function* (record: ZcodeRecord): Effect.fn.Return<void, ZcodeProtocolError> {
      const accepted = yield* Queue.offer(
        outgoing,
        new TextEncoder().encode(`${encodeJsonLine(record)}\n`),
      );
      if (!accepted) {
        return yield* Deferred.await(transportDown);
      }
    });

  const request = Effect.fn("ZcodeProtocol.request")(function* (
    method: string,
    params: ZcodeRecord,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Effect.fn.Return<unknown, ZcodeProtocolError | ZcodeProtocolTimeoutError> {
    const id = nextRequestId++;
    const deferred = yield* Deferred.make<unknown, ZcodeProtocolError>();
    pendingRequests.set(String(id), { deferred });
    yield* send({ id, method, params }).pipe(
      Effect.tapError(() => Effect.sync(() => pendingRequests.delete(String(id)))),
    );
    return yield* Effect.raceFirst(Deferred.await(deferred), Deferred.await(transportDown)).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () => Effect.fail(new ZcodeProtocolTimeoutError({ operation: method, timeoutMs })),
      }),
      Effect.onInterrupt(() => Effect.sync(() => pendingRequests.delete(String(id)))),
      Effect.onError(() => Effect.sync(() => pendingRequests.delete(String(id)))),
    );
  });

  const respond = Effect.fnUntraced(function* (
    id: string,
    result: unknown,
  ): Effect.fn.Return<void, ZcodeProtocolError> {
    yield* send({ id, result });
  });

  return {
    request,
    respond,
    events,
    exited: Deferred.await(exitDeferred),
    terminate: failTransport(
      new ZcodeProtocolError({
        operation: "terminate",
        detail: "zcode app-server was stopped",
      }),
    ).pipe(Effect.andThen(terminateProcess), Effect.ignore, Effect.uninterruptible),
  } satisfies ZcodeConnection;
});
