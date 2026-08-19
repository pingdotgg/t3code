/**
 * PiRpc — stdio JSONL transport for the Pi coding agent's RPC mode.
 *
 * Spawns `pi --mode rpc` and speaks Pi's line-delimited JSON protocol:
 * requests go to stdin as `{"type": "...", "id": "..."}` records, responses
 * come back as `{"type": "response", "id": ..., "success": ...}` and are
 * correlated by `id`; every other stdout record is a session event and is
 * surfaced on the `events` queue in arrival order.
 *
 * Framing follows Pi's spec: LF-delimited only, with a trailing `\r`
 * stripped. Lines are split manually (never with `readline`, which also
 * splits on U+2028/U+2029 and would corrupt frames). Records that fail to
 * parse as JSON are dropped with a debug log rather than failing the
 * transport, so a chatty extension cannot take the session down.
 *
 * Used by `PiAdapterV2` for sessions and by `PiTextGeneration` /
 * `PiProvider` for ephemeral one-shot processes.
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

export class PiRpcError extends Schema.TaggedErrorClass<PiRpcError>()("PiRpcError", {
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Pi RPC ${this.operation} failed${this.detail === undefined ? "" : `: ${this.detail}`}.`;
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

/**
 * Splits a `provider/model` slug into the two fields `set_model` expects.
 * Returns null for slugs without a usable separator so callers can reject the
 * selection instead of silently leaving Pi on its configured default.
 */
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
  /** Fire-and-forget write (used for `extension_ui_response`). */
  readonly send: (record: PiRpcRecord) => Effect.Effect<void, PiRpcError>;
  /**
   * Correlated request: assigns an `id`, waits for the matching response
   * record, and returns its `data` (undefined when the command carries none).
   * Fails on `success: false`, transport death, or timeout.
   */
  readonly request: (record: PiRpcRecord, timeoutMs?: number) => Effect.Effect<unknown, PiRpcError>;
  /**
   * Session events (every non-response stdout record) in arrival order. The
   * full queue is exposed so consumers can append order-preserving synthetic
   * records of their own (see PiAdapterV2's settle probe).
   */
  readonly events: Queue.Queue<PiRpcRecord, PiRpcError>;
  /** Resolves when the process has exited, with its exit code. */
  readonly exited: Effect.Effect<number, PiRpcError>;
  /**
   * Kill the pi process group immediately (SIGTERM, grace, SIGKILL). Used by
   * Stop-with-restart when the process may be wedged and `abort` cannot be
   * trusted to land. The transport fails and the session manager respawns a
   * fresh process on the next turn.
   */
  readonly terminate: Effect.Effect<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE = Duration.seconds(1);

interface PendingPiRequest {
  readonly deferred: Deferred.Deferred<unknown, PiRpcError>;
}

function splitJsonlChunks(buffer: string, chunk: string): readonly [ReadonlyArray<string>, string] {
  const combined = buffer + chunk;
  const parts = combined.split("\n");
  const remainder = parts.pop() ?? "";
  const lines = parts
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);
  return [lines, remainder];
}

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJsonLine = Schema.decodeSync(UnknownFromJsonString);
const encodeJsonLine = Schema.encodeSync(UnknownFromJsonString);

const PI_ERROR_DETAIL_MAX_CHARS = 200;

/**
 * Bounded, human-readable summary of a failed response's `error` payload.
 * The untruncated value stays on the error's `cause`, so `message` never
 * carries unbounded remote text while logs keep something diagnostic.
 */
function summarizePiError(error: unknown): string {
  const text = typeof error === "string" ? error : JSON.stringify(error);
  if (text === undefined) return "unknown error";
  return text.length > PI_ERROR_DETAIL_MAX_CHARS
    ? `${text.slice(0, PI_ERROR_DETAIL_MAX_CHARS)}…`
    : text;
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
 * Kill the pi process group: SIGTERM, short grace, then SIGKILL.
 *
 * `hasExited` is consulted before each signal. Once the original child is
 * gone its pid/pgid can be recycled by the OS, so escalating blindly could
 * deliver SIGKILL to an unrelated process.
 */
const terminatePiProcess = (kill: (signal: NodeJS.Signals) => boolean, hasExited: () => boolean) =>
  Effect.gen(function* () {
    if (hasExited()) return;
    if (!kill("SIGTERM")) return;
    yield* Effect.sleep(TERMINATION_GRACE);
    if (hasExited()) return;
    kill("SIGKILL");
  });

export const makePiRpcConnection = Effect.fnUntraced(function* (options: PiRpcSpawnOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
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

  const killProcessGroup = (signal: NodeJS.Signals): boolean => {
    try {
      if (platform === "win32") {
        process.kill(Number(child.pid), signal);
      } else {
        process.kill(-Number(child.pid), signal);
      }
      return true;
    } catch {
      return false;
    }
  };

  /** Signal 0 probes liveness without delivering anything. */
  const hasExited = (): boolean => {
    if (childExited) return true;
    try {
      process.kill(platform === "win32" ? Number(child.pid) : -Number(child.pid), 0);
      return false;
    } catch {
      return true;
    }
  };

  /**
   * Windows has no process groups, so `process.kill` reaches only pi itself
   * and leaves extension subprocesses running with inherited stdio handles.
   * `taskkill /T` reaps the whole tree.
   */
  const terminateWindowsTree = Effect.gen(function* () {
    if (hasExited()) return;
    const taskkill = yield* spawner.spawn(
      ChildProcess.make("taskkill", ["/PID", String(child.pid), "/T", "/F"]),
    );
    yield* taskkill.exitCode;
  }).pipe(Effect.scoped, Effect.ignore);

  const terminateProcess =
    platform === "win32" ? terminateWindowsTree : terminatePiProcess(killProcessGroup, hasExited);

  // Registered before any further setup: an interrupt or failure between the
  // spawn and the rest of this constructor would otherwise leak a detached
  // pi process with no finalizer to reap it.
  yield* Scope.addFinalizer(scope, terminateProcess.pipe(Effect.ignore, Effect.uninterruptible));

  const pendingRequests = new Map<string, PendingPiRequest>();
  const events = yield* Queue.unbounded<PiRpcRecord, PiRpcError>();
  const outgoing = yield* Queue.unbounded<Uint8Array, PiRpcError>();
  const transportDown = yield* Deferred.make<never, PiRpcError>();
  const exitDeferred = yield* Deferred.make<number, PiRpcError>();
  let nextRequestId = 0;

  const failTransport = (error: PiRpcError) =>
    Effect.gen(function* () {
      yield* Deferred.fail(transportDown, error);
      for (const [key, pending] of pendingRequests) {
        pendingRequests.delete(key);
        yield* Deferred.fail(pending.deferred, error);
      }
      // Closing `outgoing` is what makes `send` non-racy: once the writer is
      // gone every later offer is refused rather than silently buffered.
      yield* Queue.fail(outgoing, error);
      yield* Queue.fail(events, error);
    });

  // Writer: drain the outgoing queue into the child's stdin. If the writer
  // dies, the transport is failed so later sends surface the error instead of
  // silently queueing into a dead pipe.
  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.catchCause((cause) => failTransport(new PiRpcError({ operation: "write", cause }))),
    Effect.forkIn(scope),
  );

  const routeRecord = (record: PiRpcRecord) =>
    Effect.gen(function* () {
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

  // Reader: decode stdout into LF-delimited JSON records.
  yield* Effect.gen(function* () {
    let buffer = "";
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const [lines, remainder] = splitJsonlChunks(buffer, chunk);
          buffer = remainder;
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
    const trailing = buffer.length > 0 ? parsePiRecord(buffer) : undefined;
    if (trailing !== undefined) {
      yield* routeRecord(trailing);
    }
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => failTransport(new PiRpcError({ operation: "read", cause })),
      onSuccess: () =>
        failTransport(new PiRpcError({ operation: "read", detail: "pi process closed stdout" })),
    }),
    Effect.forkIn(scope),
  );

  // Surface stderr as debug logs; pi reserves stdout for the protocol.
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      chunk.trim().length === 0
        ? Effect.void
        : // Length only: pi's stderr is unbounded remote output and can carry
          // credentials or prompt text, so it never enters a log annotation.
          Effect.logDebug("pi stderr", { stderrLength: chunk.length }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );

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

  const send = (record: PiRpcRecord): Effect.Effect<void, PiRpcError> =>
    Effect.gen(function* () {
      const accepted = yield* Queue.offer(
        outgoing,
        new TextEncoder().encode(`${encodeJsonLine(record)}\n`),
      );
      // A refused offer means `failTransport` already closed the queue, so the
      // write can never land; surface the transport error instead of
      // reporting a success the caller cannot rely on.
      if (!accepted) {
        return yield* Deferred.await(transportDown);
      }
    });

  const request = (
    record: PiRpcRecord,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Effect.Effect<unknown, PiRpcError> =>
    Effect.gen(function* () {
      const id = `t3-${nextRequestId++}`;
      const deferred = yield* Deferred.make<unknown, PiRpcError>();
      pendingRequests.set(id, { deferred });
      yield* send({ ...record, id }).pipe(
        Effect.tapError(() => Effect.sync(() => pendingRequests.delete(id))),
      );
      // Raced against the transport: a death that lands after this request was
      // registered (or between `send`'s check and its enqueue) would otherwise
      // leave the caller waiting out the full timeout for a reply that is
      // never coming.
      return yield* Effect.raceFirst(Deferred.await(deferred), Deferred.await(transportDown)).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(timeoutMs),
          orElse: () =>
            Effect.fail(
              new PiRpcError({
                operation: String(record["type"] ?? "request"),
                detail: `timed out after ${timeoutMs}ms`,
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
    terminate: terminateProcess.pipe(Effect.ignore, Effect.uninterruptible),
  } satisfies PiRpcConnection;
});
