// NDJSON JSON-RPC 2.0 over a Unix socket or Windows named pipe.
// This is the only file that touches node:net.
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeNet from "node:net";

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RestoringSocket = Context.Reference<NodeNet.Socket | undefined>(
  "t3/provider/ZeroClawRestoringSocket",
  { defaultValue: () => undefined },
);

export class ZeroClawRpcError extends Schema.TaggedError<ZeroClawRpcError>()("ZeroClawRpcError", {
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `ZeroClaw RPC ${this.operation} failed${this.detail === undefined ? "" : `: ${this.detail}`}.`;
  }
}

export class ZeroClawRpcTimeoutError extends Schema.TaggedError<ZeroClawRpcTimeoutError>()(
  "ZeroClawRpcTimeoutError",
  {
    operation: Schema.String,
    timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  },
) {
  override get message(): string {
    return `ZeroClaw RPC ${this.operation} timed out after ${this.timeoutMs}ms.`;
  }
}

export interface ZeroClawNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface ZeroClawInboundRequest {
  readonly id: string;
  readonly method: string;
  readonly params: unknown;
}

export type ZeroClawRpcResponse =
  | { readonly _tag: "result"; readonly result: unknown }
  | { readonly _tag: "error"; readonly error: unknown };

export interface ZeroClawRpcConnection {
  readonly request: (
    method: string,
    params: unknown,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, ZeroClawRpcError | ZeroClawRpcTimeoutError>;
  readonly notify: (method: string, params: unknown) => Effect.Effect<void, ZeroClawRpcError>;
  readonly events: Queue.Queue<ZeroClawNotification, ZeroClawRpcError>;
  readonly inboundRequests: Queue.Queue<ZeroClawInboundRequest, ZeroClawRpcError>;
  readonly respond: (
    id: string,
    response: ZeroClawRpcResponse,
  ) => Effect.Effect<void, ZeroClawRpcError>;
  readonly closed: Effect.Effect<void, ZeroClawRpcError>;
  readonly terminate: Effect.Effect<void>;
}

export interface ZeroClawRpcConnectionOptions {
  readonly socketPath: string;
  /**
   * Reconnect when the socket drops. `onReconnect` runs after the socket is
   * back so it can restore state the restart dropped. External requests wait
   * until restoration completes; the callback can make its own requests.
   */
  readonly reconnect?: {
    readonly onReconnect?: () => Effect.Effect<void>;
  };
}

interface PendingRequest {
  readonly deferred: Deferred.Deferred<unknown, ZeroClawRpcError>;
  /** A queue the request fiber takes from, because Deferred completion from another fiber does not resume it here. */
  readonly reply: Queue.Queue<Effect.Effect<unknown, ZeroClawRpcError>>;
  settled: boolean;
}

interface RpcFrame {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJsonLine = Schema.decodeSync(UnknownFromJsonString);
const encodeJsonLine = Schema.encodeSync(UnknownFromJsonString);

const ERROR_DETAIL_MAX_CHARS = 200;

function summarizeError(error: unknown): string {
  const text = typeof error === "string" ? error : JSON.stringify(error);
  if (text === undefined) return "unknown error";
  return text.length > ERROR_DETAIL_MAX_CHARS ? `${text.slice(0, ERROR_DETAIL_MAX_CHARS)}…` : text;
}

function rpcId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function parseFrame(line: string): RpcFrame | undefined {
  try {
    const parsed: unknown = decodeJsonLine(line);
    return Predicate.isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Split a byte stream into NDJSON lines. A line that would exceed `maxBytes`
 * fails the framer instead of being delivered, matching the daemon's refusal
 * to continue past an oversized frame.
 */
export function makeNdjsonFramer(maxBytes: number) {
  let buffer = "";
  let overflowed = false;
  let bufferedBytes = 0;
  return (
    chunk: string,
  ): { readonly lines: ReadonlyArray<string>; readonly overflowed: boolean } => {
    if (overflowed) return { lines: [], overflowed: true };
    const lines: string[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.slice(start, end);
      bufferedBytes += Buffer.byteLength(part, "utf8");
      if (bufferedBytes > maxBytes) {
        buffer = "";
        overflowed = true;
        return { lines, overflowed: true };
      }
      buffer += part;
      if (newline < 0) break;
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.length > 0) lines.push(line);
      buffer = "";
      bufferedBytes = 0;
      start = newline + 1;
    }
    return { lines, overflowed: false };
  };
}

function connectSocket(
  path: string,
  onData: (chunk: Buffer | string) => void,
  /** A reconnect's socket must outlive the fiber that opened it. */
  managed: boolean,
): Effect.Effect<NodeNet.Socket, ZeroClawRpcError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.callback<NodeNet.Socket, ZeroClawRpcError>((resume) => {
      const socket = NodeNet.createConnection({ path });
      // Attach before connect settles so a fast handshake is not lost.
      socket.setEncoding("utf8");
      socket.on("data", onData);
      let settled = false;
      const settle = (effect: Effect.Effect<NodeNet.Socket, ZeroClawRpcError>) => {
        if (settled) return;
        settled = true;
        resume(effect);
      };
      socket.once("connect", () => {
        socket.resume();
        settle(Effect.succeed(socket));
      });
      socket.once("error", (cause) => {
        settle(
          Effect.fail(
            new ZeroClawRpcError({
              operation: "connect",
              detail: cause.message,
              cause,
            }),
          ),
        );
      });
      return Effect.sync(() => {
        socket.destroy();
      });
    }),
    (socket) =>
      managed
        ? Effect.sync(() => {
            socket.destroy();
          })
        : Effect.void,
  );
}

function writeLine(
  socket: NodeNet.Socket,
  record: unknown,
  operation: string,
): Effect.Effect<void, ZeroClawRpcError> {
  return Effect.callback<void, ZeroClawRpcError>((resume) => {
    let settled = false;
    const settle = (effect: Effect.Effect<void, ZeroClawRpcError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    socket.write(`${encodeJsonLine(record)}\n`, (cause) => {
      if (cause) {
        settle(Effect.fail(new ZeroClawRpcError({ operation, detail: cause.message, cause })));
        return;
      }
      settle(Effect.void);
    });
    return Effect.void;
  });
}

const RECONNECT_DELAYS_MS = [200, 400, 800, 1_600, 3_200, 5_000];
const RECONNECT_ATTEMPTS = 30;

export const makeZeroClawRpcConnection = Effect.fn("makeZeroClawRpcConnection")(function* (
  options: ZeroClawRpcConnectionOptions,
) {
  const scope = yield* Effect.scope;
  const events = yield* Queue.unbounded<ZeroClawNotification, ZeroClawRpcError>();
  const inboundRequests = yield* Queue.unbounded<ZeroClawInboundRequest, ZeroClawRpcError>();
  const pendingRequests = new Map<string, PendingRequest>();
  const incomingFrames = yield* Queue.unbounded<RpcFrame, ZeroClawRpcError>();
  /** The socket writes go to. Reconnect swaps it; the data callback reads it. */
  const current: { socket: NodeNet.Socket | undefined } = { socket: undefined };
  const makeOnData = () => {
    const frame = makeNdjsonFramer(MAX_FRAME_BYTES);
    return (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const framed = frame(text);
      for (const line of framed.lines) {
        const parsed = parseFrame(line);
        if (parsed === undefined) continue;
        // Hand the frame to a fiber. Completing a deferred from this callback
        // does not resume a waiter in this runtime.
        Queue.offerUnsafe(incomingFrames, parsed);
      }
      if (framed.overflowed) {
        for (const [key, pending] of pendingRequests) {
          pendingRequests.delete(key);
          Queue.offerUnsafe(
            pending.reply,
            Effect.fail(
              new ZeroClawRpcError({
                operation: "read",
                detail: `Frame exceeded ${MAX_FRAME_BYTES} bytes`,
              }),
            ),
          );
        }
        current.socket?.destroy();
      }
    };
  };
  const socket = yield* connectSocket(options.socketPath, makeOnData(), true);
  current.socket = socket;

  const outgoing = yield* Queue.unbounded<
    {
      readonly socket: NodeNet.Socket;
      readonly record: unknown;
      readonly requestId: string | undefined;
    },
    ZeroClawRpcError
  >();
  const transportDown = yield* Deferred.make<never, ZeroClawRpcError>();
  const closed = yield* Deferred.make<void, ZeroClawRpcError>();
  /** A dropped socket offers here when the connection should reopen instead of dying. */
  const socketLost = yield* Queue.unbounded<ZeroClawRpcError>();
  let nextRequestId = 0;
  let stopped = false;
  let restoration: Deferred.Deferred<void> | undefined;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      stopped = true;
      current.socket?.destroy();
      current.socket = undefined;
    }),
  );

  const failTransport = Effect.fnUntraced(function* (error: ZeroClawRpcError) {
    const claimed = yield* Deferred.fail(transportDown, error);
    if (!claimed) return;
    stopped = true;
    current.socket?.destroy();
    current.socket = undefined;
    yield* Deferred.fail(closed, error);
    for (const [key, pending] of pendingRequests) {
      pendingRequests.delete(key);
      yield* Deferred.fail(pending.deferred, error);
    }
    yield* Queue.fail(outgoing, error);
    yield* Queue.fail(events, error);
    yield* Queue.fail(inboundRequests, error);
  });

  const routeFrame = Effect.fnUntraced(function* (frame: RpcFrame) {
    const id = rpcId(frame.id);
    const method = typeof frame.method === "string" ? frame.method : undefined;
    const isResponse = frame.result !== undefined || frame.error !== undefined;
    if (id !== undefined && isResponse) {
      const pending = pendingRequests.get(id);
      if (pending === undefined) {
        // A response we did not send must not be answered; that could complete
        // an unrelated request traveling the other direction.
        yield* Effect.logDebug("Dropping unmatched ZeroClaw RPC response.", { id });
        return;
      }
      pendingRequests.delete(id);
      pending.settled = true;
      yield* Queue.offer(
        pending.reply,
        frame.error !== undefined
          ? Effect.fail(
              new ZeroClawRpcError({
                operation: "request",
                detail: summarizeError(frame.error),
                cause: frame.error,
              }),
            )
          : Effect.succeed(frame.result),
      );
      return;
    }
    if (method !== undefined && id !== undefined) {
      yield* Queue.offer(inboundRequests, { id, method, params: frame.params });
      return;
    }
    if (method !== undefined) {
      yield* Queue.offer(events, { method, params: frame.params });
      return;
    }
    yield* Effect.logDebug("Dropping malformed ZeroClaw RPC frame.");
  });

  yield* Stream.fromQueue(incomingFrames).pipe(
    Stream.runForEach((parsed) => routeFrame(parsed)),
    Effect.forkIn(scope),
  );

  // A dropped socket fails every request waiting on it, then either reopens or
  // ends the connection. A request with no timeout would otherwise wait forever.
  const reportSocketLost = (lost: NodeNet.Socket, error: ZeroClawRpcError) => {
    if (stopped || lost !== current.socket) return;
    current.socket = undefined;
    for (const [key, pending] of pendingRequests) {
      pendingRequests.delete(key);
      Queue.offerUnsafe(pending.reply, Effect.fail(error));
    }
    Queue.offerUnsafe(socketLost, error);
  };
  const watchSocket = (watched: NodeNet.Socket) => {
    watched.once("close", () => {
      reportSocketLost(
        watched,
        new ZeroClawRpcError({ operation: "read", detail: "Connection closed" }),
      );
    });
    watched.on("error", (cause: Error) => {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ECONNRESET" || code === "EPIPE") return;
      reportSocketLost(
        watched,
        new ZeroClawRpcError({ operation: "read", detail: cause.message, cause }),
      );
    });
  };
  watchSocket(socket);

  const reopen = Effect.fnUntraced(function* (lost: ZeroClawRpcError) {
    let lastError: ZeroClawRpcError = lost;
    for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt++) {
      if (stopped) return;
      yield* Effect.sleep(
        Duration.millis(
          RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 0,
        ),
      );
      if (stopped) return;
      // Unmanaged: this fiber ends, and the socket must outlive it.
      const opened = yield* connectSocket(options.socketPath, makeOnData(), false).pipe(
        Effect.exit,
      );
      if (opened._tag === "Failure") {
        if (stopped) return;
        const failure = Cause.squash(opened.cause);
        lastError =
          failure instanceof Error && failure.name === "ZeroClawRpcError"
            ? (failure as ZeroClawRpcError)
            : lost;
        continue;
      }
      if (stopped) {
        opened.value.destroy();
        return;
      }
      // Claim the socket before watching it: its close can fire synchronously.
      const ready = yield* Deferred.make<void>();
      restoration = ready;
      current.socket = opened.value;
      watchSocket(opened.value);
      const restored = yield* (options.reconnect?.onReconnect?.() ?? Effect.void).pipe(
        Effect.provideService(RestoringSocket, opened.value),
        Effect.exit,
      );
      if (restored._tag === "Failure") {
        yield* failTransport(
          new ZeroClawRpcError({ operation: "reconnect", cause: restored.cause }),
        );
        return;
      }
      restoration = undefined;
      yield* Deferred.succeed(ready, undefined);
      yield* Effect.logInfo("ZeroClaw daemon socket reconnected.");
      return;
    }
    yield* failTransport(lastError);
  });

  yield* Stream.fromQueue(socketLost).pipe(
    Stream.runForEach((error) =>
      options.reconnect !== undefined ? reopen(error) : failTransport(error),
    ),
    Effect.forkIn(scope),
  );

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.runForEach(({ socket: target, record, requestId }) => {
      const write =
        target !== current.socket || stopped
          ? Effect.fail(new ZeroClawRpcError({ operation: "write", detail: "Connection closed" }))
          : writeLine(target, record, "write");
      return write.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (options.reconnect === undefined) return yield* failTransport(error);
            if (requestId !== undefined) {
              const pending = pendingRequests.get(requestId);
              pendingRequests.delete(requestId);
              if (pending !== undefined) yield* Queue.offer(pending.reply, Effect.fail(error));
            }
            reportSocketLost(target, error);
            target.destroy();
          }),
        ),
      );
    }),
    Effect.catchCause((cause) =>
      failTransport(new ZeroClawRpcError({ operation: "write", cause })),
    ),
    Effect.forkIn(scope),
  );

  const enqueue = Effect.fnUntraced(function* (
    record: unknown,
    operation: string,
    requestId?: string,
  ) {
    const target = current.socket;
    if (stopped || target === undefined || target.destroyed) {
      return yield* new ZeroClawRpcError({ operation, detail: "Connection closed" });
    }
    const ready = restoration;
    if (ready !== undefined && (yield* RestoringSocket) !== target) {
      yield* Effect.raceFirst(Deferred.await(ready), Deferred.await(transportDown));
      if (stopped || current.socket !== target || target.destroyed) {
        return yield* new ZeroClawRpcError({ operation, detail: "Connection closed" });
      }
    }
    const accepted = yield* Queue.offer(outgoing, { socket: target, record, requestId });
    if (!accepted) {
      return yield* new ZeroClawRpcError({
        operation,
        detail: "Connection closed",
      });
    }
  });

  const request = Effect.fn("ZeroClawRpc.request")(function* (
    method: string,
    params: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    const id = `t3-out-${nextRequestId++}`;
    const deferred = yield* Deferred.make<unknown, ZeroClawRpcError>();
    const reply = yield* Queue.bounded<Effect.Effect<unknown, ZeroClawRpcError>>(1);
    pendingRequests.set(id, { deferred, reply, settled: false });
    yield* enqueue({ jsonrpc: "2.0", id, method, params }, method, id).pipe(
      Effect.tapError(() => Effect.sync(() => pendingRequests.delete(id))),
      Effect.onInterrupt(() => Effect.sync(() => pendingRequests.delete(id))),
    );
    // Let the socket's data callback complete the deferred before we wait.
    yield* Effect.yieldNow;
    const awaiting = Effect.raceFirst(
      Queue.take(reply).pipe(Effect.flatten),
      Deferred.await(transportDown),
    ).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()));
    return yield* (
      timeoutMs > 0
        ? awaiting.pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(timeoutMs),
              orElse: () =>
                Effect.fail(new ZeroClawRpcTimeoutError({ operation: method, timeoutMs })),
            }),
          )
        : awaiting
    ).pipe(
      Effect.onInterrupt(() => Effect.sync(() => pendingRequests.delete(id))),
      Effect.onError(() => Effect.sync(() => pendingRequests.delete(id))),
    );
  });

  const respond = Effect.fn("ZeroClawRpc.respond")(function* (
    id: string,
    response: ZeroClawRpcResponse,
  ) {
    const body =
      response._tag === "result"
        ? { jsonrpc: "2.0", id, result: response.result }
        : { jsonrpc: "2.0", id, error: response.error };
    yield* enqueue(body, "respond");
  });

  return {
    request,
    notify: (method, params) => enqueue({ jsonrpc: "2.0", method, params }, method),
    events,
    inboundRequests,
    respond,
    closed: Deferred.await(closed),
    terminate: Effect.sync(() => {
      stopped = true;
    }).pipe(
      Effect.andThen(
        failTransport(
          new ZeroClawRpcError({ operation: "terminate", detail: "connection was stopped" }),
        ),
      ),
      Effect.andThen(
        Effect.sync(() => {
          current.socket?.destroy();
        }),
      ),
      Effect.ignore,
      Effect.uninterruptible,
    ),
  } satisfies ZeroClawRpcConnection;
});
