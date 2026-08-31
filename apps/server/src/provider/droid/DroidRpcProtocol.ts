import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  DroidAskUserRequest,
  DroidPermissionRequest,
  DroidSessionNotification,
  knownDroidSessionNotificationTypes,
  type DroidAskUserRequest as DroidAskUserRequestType,
  type DroidPermissionRequest as DroidPermissionRequestType,
  type DroidSessionNotification as DroidSessionNotificationType,
} from "./DroidProtocol.ts";
import { logDroidWarning } from "./DroidDiagnostics.ts";

export const DROID_SESSION_REQUEST_TIMEOUT_MS = 75_000;
export const DROID_SERVER_REQUEST_CONCURRENCY = 16;
const losslessBacklogHardLimit = 8192;
// A T3 turn can carry eight 14M-character image data URLs (~112 MiB) plus
// prompt and envelope metadata. Keep one valid maximum-sized Factory frame
// deliverable while still bounding malformed or abandoned streams.
const maxJsonRpcMessageBytes = 128 * 1024 * 1024;
const losslessBacklogHardLimitBytes = maxJsonRpcMessageBytes;

const factoryApiVersion = "1.0.0";
const factoryProtocolVersion = "1.187.0";
const timedOutRequestRetentionLimit = 256;
const outgoingQueueCapacity = 2;
const notificationQueueCapacity = 64;
const lossyNotificationQueueLimit = notificationQueueCapacity - 1;
const serverRequestQueueCapacity = DROID_SERVER_REQUEST_CONCURRENCY;
const lossyNotificationTypes: ReadonlySet<string> = new Set(["tool_progress_update"]);

export interface DroidProcessExit {
  readonly code: number | null;
  readonly description: string;
}

export class DroidRpcError extends Schema.TaggedErrorClass<DroidRpcError>()("DroidRpcError", {
  kind: Schema.Literals([
    "encode",
    "write",
    "protocol",
    "timeout",
    "rpc",
    "process-exit",
    "duplicate-response",
    "duplicate-server-response",
    "message-too-large",
    "frame-too-large",
    "backlog-overflow",
  ]),
  method: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.Number),
  data: Schema.optionalKey(Schema.Unknown),
  cause: Schema.optionalKey(Schema.Defect()),
  rpcMessage: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Number),
  exitDescription: Schema.optionalKey(Schema.String),
  actualBytes: Schema.optionalKey(Schema.Number),
  limitBytes: Schema.optionalKey(Schema.Number),
}) {
  override get message() {
    switch (this.kind) {
      case "encode":
        return "Failed to encode Droid JSON-RPC message";
      case "write":
        return "Failed to write to Droid process stdin because it is closed";
      case "protocol":
        return this.rpcMessage ?? "Droid sent an invalid JSON-RPC message";
      case "timeout":
        return `Droid request ${this.method} timed out after ${this.timeoutMs}ms`;
      case "rpc":
        return this.rpcMessage ?? "Droid returned an invalid JSON-RPC error response";
      case "process-exit":
        return this.requestId === undefined
          ? `Cannot start Droid request ${this.method}: ${this.exitDescription}`
          : `Droid process exited while ${this.method} was pending`;
      case "duplicate-response":
        return `Droid request ${this.method} responded after timing out`;
      case "duplicate-server-response":
        return `Droid server request ${this.method} was answered more than once`;
      case "message-too-large":
        return `Droid JSON-RPC message is ${this.actualBytes} bytes; limit is ${this.limitBytes}`;
      case "frame-too-large":
        return `Droid JSON-RPC line exceeded the ${this.limitBytes} byte limit`;
      case "backlog-overflow":
        return "Droid lossless backlog exceeded its hard limit because the consumer stopped draining";
    }
  }
}

interface DroidServerRequestBase {
  readonly id: string;
  readonly sessionId: string | undefined;
  readonly sequence: number;
  readonly respond: (result: unknown) => Effect.Effect<void, DroidRpcError>;
  readonly fail: (code: number, message: string) => Effect.Effect<void, DroidRpcError>;
}

export interface DroidPermissionServerRequest extends DroidServerRequestBase {
  readonly method: "droid.request_permission";
  readonly params: DroidPermissionRequestType;
  readonly rawParams: unknown;
}

export interface DroidAskUserServerRequest extends DroidServerRequestBase {
  readonly method: "droid.ask_user";
  readonly params: DroidAskUserRequestType;
}

export type DroidServerRequest = DroidPermissionServerRequest | DroidAskUserServerRequest;

export interface DroidNotificationEnvelope {
  readonly sessionId: string | undefined;
  readonly notification: DroidSessionNotificationType;
}

export interface DroidRpcProtocol {
  readonly request: (
    method: string,
    params: unknown,
    options?: { readonly timeoutMs?: number | undefined },
  ) => Effect.Effect<unknown, DroidRpcError>;
  readonly notifications: Stream.Stream<DroidNotificationEnvelope>;
  readonly serverRequests: Stream.Stream<DroidServerRequest>;
  readonly latestServerRequestSequence: Effect.Effect<number>;
  readonly outgoing: Stream.Stream<string>;
  readonly acceptChunk: (chunk: string) => Effect.Effect<void, DroidRpcError>;
  readonly endInput: Effect.Effect<void, DroidRpcError>;
  readonly beginShutdown: (exit?: DroidProcessExit) => Effect.Effect<boolean>;
  readonly closeOutgoing: Effect.Effect<void>;
  readonly handleExit: (exit: DroidProcessExit) => Effect.Effect<void>;
}

const JsonRpcEnvelopeFields = {
  jsonrpc: Schema.Literal("2.0"),
  factoryApiVersion: Schema.Literal(factoryApiVersion),
  factoryProtocolVersion: Schema.String,
} as const;

const JsonRpcErrorPayload = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
});

const JsonRpcRequest = Schema.Struct({
  ...JsonRpcEnvelopeFields,
  type: Schema.Literal("request"),
  id: Schema.String,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});

const JsonRpcResponseSuccess = Schema.Struct({
  ...JsonRpcEnvelopeFields,
  type: Schema.Literal("response"),
  id: Schema.String,
  result: Schema.Unknown,
  error: Schema.optionalKey(Schema.Never),
});

const JsonRpcResponseFailure = Schema.Struct({
  ...JsonRpcEnvelopeFields,
  type: Schema.Literal("response"),
  id: Schema.String,
  result: Schema.optionalKey(Schema.Never),
  error: JsonRpcErrorPayload,
});

const JsonRpcNotification = Schema.Struct({
  ...JsonRpcEnvelopeFields,
  type: Schema.Literal("notification"),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});

const JsonRpcMessage = Schema.Union([
  JsonRpcRequest,
  JsonRpcResponseSuccess,
  JsonRpcResponseFailure,
  JsonRpcNotification,
]);
type JsonRpcMessage = typeof JsonRpcMessage.Type;

interface PendingRequest {
  readonly _tag: "Pending";
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, DroidRpcError>;
  readonly sent: boolean;
}

interface TimedOutRequest {
  readonly _tag: "TimedOut";
  readonly method: string;
}

type RequestState = PendingRequest | TimedOutRequest;

type DroidRpcLifecycle =
  | {
      readonly _tag: "Running";
      readonly pending: ReadonlyMap<string, RequestState>;
    }
  | {
      readonly _tag: "ShuttingDown";
      readonly pending: ReadonlyMap<string, RequestState>;
      readonly exit?: DroidProcessExit;
    }
  | {
      readonly _tag: "Exited";
      readonly exit: DroidProcessExit;
    };

interface LineFramingState {
  readonly remainder: string;
  readonly bytes: number;
}

interface FramedLine {
  readonly line: string;
  readonly bytes: number;
}

interface QueuedDelivery<A> {
  readonly value: A;
  readonly encodedBytes: number;
}

interface LosslessBacklogState {
  readonly items: number;
  readonly bytes: number;
}

type LosslessBacklogReservation =
  | {
      readonly _tag: "Overflow";
      readonly actualBytes: number;
      readonly backlog: number;
    }
  | {
      readonly _tag: "Reserved";
      readonly warn: boolean;
    };

type OutgoingFrame =
  | {
      readonly _tag: "Request";
      readonly encoded: string;
      readonly requestId: string;
      readonly deferred: Deferred.Deferred<unknown, DroidRpcError>;
    }
  | {
      readonly _tag: "Uncorrelated";
      readonly encoded: string;
    };

const decodeJsonRpcMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRpcMessage));
const decodeNotification = Schema.decodeUnknownEffect(DroidSessionNotification);
const decodePermissionRequest = Schema.decodeUnknownEffect(DroidPermissionRequest);
const decodeAskUserRequest = Schema.decodeUnknownEffect(DroidAskUserRequest);
const encodeJsonRpcMessage = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

function markRequestTimedOut(
  pending: ReadonlyMap<string, RequestState>,
  requestId: string,
  method: string,
  retentionLimit: number,
): ReadonlyMap<string, RequestState> {
  const next = new Map(pending);
  next.delete(requestId);
  next.set(requestId, { _tag: "TimedOut", method });

  let timedOutCount = 0;
  for (const request of next.values()) {
    if (request._tag === "TimedOut") timedOutCount += 1;
  }
  if (timedOutCount <= retentionLimit) return next;

  for (const [retainedRequestId, request] of next) {
    if (request._tag !== "TimedOut") continue;
    next.delete(retainedRequestId);
    timedOutCount -= 1;
    if (timedOutCount <= retentionLimit) break;
  }
  return next;
}

const consumeChunk = (
  state: LineFramingState,
  chunk: string,
  maxMessageBytes: number,
  handleLine: (line: FramedLine) => Effect.Effect<void, DroidRpcError>,
): Effect.Effect<LineFramingState, DroidRpcError> =>
  Effect.gen(function* () {
    let remainder = state.remainder;
    let bytes = state.bytes;
    let cursor = 0;
    const delimiters = /\r\n|\r|\n/g;

    for (const delimiter of chunk.matchAll(delimiters)) {
      const index = delimiter.index;
      const segment = chunk.slice(cursor, index);
      bytes += Buffer.byteLength(segment, "utf8");
      if (bytes > maxMessageBytes) {
        return yield* new DroidRpcError({
          kind: "frame-too-large",
          actualBytes: bytes,
          limitBytes: maxMessageBytes,
        });
      }
      yield* handleLine({
        line: remainder.length === 0 ? segment : remainder + segment,
        bytes,
      });
      remainder = "";
      bytes = 0;
      cursor = index + delimiter[0].length;
    }

    const tail = chunk.slice(cursor);
    if (tail.length > 0) {
      bytes += Buffer.byteLength(tail, "utf8");
      if (bytes > maxMessageBytes) {
        return yield* new DroidRpcError({
          kind: "frame-too-large",
          actualBytes: bytes,
          limitBytes: maxMessageBytes,
        });
      }
      remainder += tail;
    }

    return { remainder, bytes };
  });

function jsonRpcErrorFromMessage(
  error: typeof JsonRpcErrorPayload.Type,
  method: string,
  requestId: string,
): DroidRpcError {
  return new DroidRpcError({
    kind: "rpc",
    rpcMessage: error.message,
    method,
    requestId,
    code: error.code,
    ...(error.data === undefined ? {} : { data: error.data }),
  });
}

const processExitError = (
  exit: DroidProcessExit,
  method: string,
  requestId?: string,
): DroidRpcError =>
  new DroidRpcError({
    kind: "process-exit",
    method,
    ...(requestId === undefined ? {} : { requestId }),
    ...(requestId === undefined ? { exitDescription: exit.description } : {}),
    data: exit,
  });

export const makeDroidRpcProtocol = (
  limits: {
    readonly maxMessageBytes?: number;
    readonly maxBacklogBytes?: number;
    readonly maxBacklogItems?: number;
    readonly timedOutRequestRetentionLimit?: number;
  } = {},
): Effect.Effect<DroidRpcProtocol> =>
  Effect.gen(function* () {
    const maxMessageBytes = limits.maxMessageBytes ?? maxJsonRpcMessageBytes;
    const maxBacklogBytes = limits.maxBacklogBytes ?? losslessBacklogHardLimitBytes;
    const maxBacklogItems = limits.maxBacklogItems ?? losslessBacklogHardLimit;
    const requestTombstoneLimit =
      limits.timedOutRequestRetentionLimit ?? timedOutRequestRetentionLimit;
    const outgoing = yield* Queue.bounded<OutgoingFrame, Cause.Done<void>>(outgoingQueueCapacity);
    const notifications = yield* Queue.unbounded<
      QueuedDelivery<DroidNotificationEnvelope>,
      Cause.Done<void>
    >();
    const serverRequests = yield* Queue.unbounded<
      QueuedDelivery<DroidServerRequest>,
      Cause.Done<void>
    >();
    const notificationBacklog = yield* Ref.make<LosslessBacklogState>({
      items: 0,
      bytes: 0,
    });
    const serverRequestBacklog = yield* Ref.make<LosslessBacklogState>({
      items: 0,
      bytes: 0,
    });
    const notificationBacklogMutex = yield* Semaphore.make(1);
    const serverRequestBacklogMutex = yield* Semaphore.make(1);
    const lifecycle = yield* SynchronizedRef.make<DroidRpcLifecycle>({
      _tag: "Running",
      pending: new Map(),
    });
    const framing = yield* SynchronizedRef.make<LineFramingState>({
      remainder: "",
      bytes: 0,
    });
    const nextRequestId = yield* Ref.make(0);
    const nextServerRequestSequence = yield* Ref.make(0);
    const droppedLossyNotificationCount = yield* Ref.make(0);

    const writeEnvelope = (
      message: Record<string, unknown>,
      requestIdentity?: {
        readonly requestId: string;
        readonly deferred: Deferred.Deferred<unknown, DroidRpcError>;
      },
    ): Effect.Effect<void, DroidRpcError> =>
      encodeJsonRpcMessage(message).pipe(
        Effect.map((encoded) => `${encoded}\n`),
        Effect.mapError(
          (cause) =>
            new DroidRpcError({
              kind: "encode",
              cause,
            }),
        ),
        Effect.flatMap((encoded) => {
          const actualBytes = Buffer.byteLength(encoded, "utf8");
          return actualBytes <= maxMessageBytes
            ? Effect.succeed(encoded)
            : Effect.fail(
                new DroidRpcError({
                  kind: "message-too-large",
                  actualBytes,
                  limitBytes: maxMessageBytes,
                }),
              );
        }),
        Effect.flatMap((encoded) =>
          Queue.offer(
            outgoing,
            requestIdentity === undefined
              ? { _tag: "Uncorrelated", encoded }
              : { _tag: "Request", encoded, ...requestIdentity },
          ),
        ),
        Effect.flatMap((offered) =>
          offered
            ? Effect.void
            : Effect.fail(
                new DroidRpcError({
                  kind: "write",
                }),
              ),
        ),
      );

    const sendResponse = (
      id: string,
      result:
        | { readonly _tag: "Success"; readonly value: unknown }
        | { readonly _tag: "Failure"; readonly code: number; readonly message: string },
    ) =>
      writeEnvelope({
        jsonrpc: "2.0",
        type: "response",
        factoryApiVersion,
        factoryProtocolVersion,
        id,
        ...(result._tag === "Success"
          ? { result: result.value }
          : { error: { code: result.code, message: result.message } }),
      });

    const makeServerRequestBase = (
      id: string,
      method: string,
      sessionId: string | undefined,
      sequence: number,
    ) =>
      Effect.gen(function* () {
        const answered = yield* SynchronizedRef.make(false);
        const answerOnce = (
          result:
            | { readonly _tag: "Success"; readonly value: unknown }
            | { readonly _tag: "Failure"; readonly code: number; readonly message: string },
        ) =>
          SynchronizedRef.modifyEffect(answered, (alreadyAnswered) =>
            alreadyAnswered
              ? Effect.fail(
                  new DroidRpcError({
                    kind: "duplicate-server-response",
                    method,
                    requestId: id,
                  }),
                )
              : sendResponse(id, result).pipe(Effect.as([undefined, true] as const)),
          );
        return {
          id,
          sessionId,
          sequence,
          respond: (result: unknown) => answerOnce({ _tag: "Success", value: result }),
          fail: (code: number, message: string) => answerOnce({ _tag: "Failure", code, message }),
        };
      });

    const offerLossless = <A>(
      queueName: "notifications" | "server-requests",
      queue: Queue.Queue<QueuedDelivery<A>, Cause.Done<void>>,
      backlogState: Ref.Ref<LosslessBacklogState>,
      backlogMutex: Semaphore.Semaphore,
      item: QueuedDelivery<A>,
      warningCount: number,
    ) =>
      Effect.gen(function* () {
        const reservation = yield* backlogMutex.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const current = yield* Ref.get(backlogState);
              const next = {
                items: current.items + 1,
                bytes: current.bytes + item.encodedBytes,
              };
              if (current.items >= maxBacklogItems || next.bytes > maxBacklogBytes) {
                return {
                  _tag: "Overflow",
                  actualBytes: next.bytes,
                  backlog: current.items,
                } satisfies LosslessBacklogReservation;
              }
              const offered = yield* Queue.offer(queue, item);
              if (offered) {
                yield* Ref.set(backlogState, next);
              }
              return {
                _tag: "Reserved",
                warn: offered && current.items === warningCount,
              } satisfies LosslessBacklogReservation;
            }),
          ),
        );
        if (reservation._tag === "Overflow") {
          return yield* new DroidRpcError({
            kind: "backlog-overflow",
            actualBytes: reservation.actualBytes,
            limitBytes: maxBacklogBytes,
            data: {
              queue: queueName,
              backlog: reservation.backlog,
              limit: maxBacklogItems,
            },
          });
        }
        if (reservation.warn) {
          yield* logDroidWarning(
            `Droid ${queueName} backlog exceeded ${warningCount}; the consumer is falling behind`,
          );
        }
      });

    const resolveResponse = (
      message: typeof JsonRpcResponseSuccess.Type | typeof JsonRpcResponseFailure.Type,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const requestId = message.id;
        const requestState = yield* SynchronizedRef.modify(lifecycle, (state) => {
          if (state._tag === "Exited") return [undefined, state] as const;
          const found = state.pending.get(requestId);
          if (!found) return [undefined, state] as const;
          const next = new Map(state.pending);
          next.delete(requestId);
          return [found, { ...state, pending: next }] as const;
        });
        if (!requestState) {
          yield* logDroidWarning(`Ignoring response for unknown Droid request ${requestId}`);
          return;
        }
        if (requestState._tag === "TimedOut") {
          const error = new DroidRpcError({
            kind: "duplicate-response",
            method: requestState.method,
            requestId,
          });
          yield* logDroidWarning(error.message, { error });
          return;
        }
        if ("error" in message) {
          yield* Deferred.fail(
            requestState.deferred,
            jsonRpcErrorFromMessage(message.error, requestState.method, requestId),
          );
          return;
        }
        yield* Deferred.succeed(requestState.deferred, message.result);
      });

    const handleServerRequest = (
      message: typeof JsonRpcRequest.Type,
      encodedBytes: number,
    ): Effect.Effect<void, DroidRpcError> =>
      Effect.gen(function* () {
        const sequence = yield* Ref.updateAndGet(
          nextServerRequestSequence,
          (current) => current + 1,
        );
        const sessionId =
          Predicate.isObject(message.params) && typeof message.params.sessionId === "string"
            ? message.params.sessionId
            : undefined;
        if (message.method === "droid.request_permission") {
          const decoded = yield* decodePermissionRequest(message.params).pipe(Effect.result);
          if (decoded._tag === "Failure") {
            yield* logDroidWarning("Unable to decode droid.request_permission params", {
              error: decoded.failure,
            });
            yield* sendResponse(message.id, {
              _tag: "Failure",
              code: -32602,
              message: "Invalid droid.request_permission params",
            }).pipe(Effect.ignore);
            return;
          }
          const requestBase = yield* makeServerRequestBase(
            message.id,
            message.method,
            sessionId,
            sequence,
          );
          yield* offerLossless(
            "server-requests",
            serverRequests,
            serverRequestBacklog,
            serverRequestBacklogMutex,
            {
              encodedBytes,
              value: {
                ...requestBase,
                method: message.method,
                params: decoded.success,
                rawParams: message.params,
              },
            },
            serverRequestQueueCapacity,
          );
          return;
        }
        if (message.method === "droid.ask_user") {
          const decoded = yield* decodeAskUserRequest(message.params).pipe(Effect.result);
          if (decoded._tag === "Failure") {
            yield* logDroidWarning("Unable to decode droid.ask_user params", {
              error: decoded.failure,
            });
            yield* sendResponse(message.id, {
              _tag: "Failure",
              code: -32602,
              message: "Invalid droid.ask_user params",
            }).pipe(Effect.ignore);
            return;
          }
          const requestBase = yield* makeServerRequestBase(
            message.id,
            message.method,
            sessionId,
            sequence,
          );
          yield* offerLossless(
            "server-requests",
            serverRequests,
            serverRequestBacklog,
            serverRequestBacklogMutex,
            {
              encodedBytes,
              value: {
                ...requestBase,
                method: message.method,
                params: decoded.success,
              },
            },
            serverRequestQueueCapacity,
          );
          return;
        }
        yield* logDroidWarning(
          `Ignoring unsupported server-initiated Droid request ${message.method}`,
        );
        yield* sendResponse(message.id, {
          _tag: "Failure",
          code: -32601,
          message: `Unsupported Droid request: ${message.method}`,
        }).pipe(Effect.ignore);
      });

    const handleNotification = (
      message: typeof JsonRpcNotification.Type,
      encodedBytes: number,
    ): Effect.Effect<void, DroidRpcError> =>
      Effect.gen(function* () {
        if (message.method !== "droid.session_notification") return;
        if (!Predicate.isObject(message.params)) {
          yield* logDroidWarning("Ignoring Droid session notification with invalid params");
          return;
        }
        const rawNotification = message.params.notification;
        if (!Predicate.isObject(rawNotification) || typeof rawNotification.type !== "string") {
          yield* logDroidWarning("Ignoring Droid session notification without a string type");
          return;
        }
        if (!knownDroidSessionNotificationTypes.has(rawNotification.type)) {
          yield* logDroidWarning(
            `Ignoring unknown Droid session notification ${rawNotification.type}`,
          );
          return;
        }
        const decoded = yield* decodeNotification(rawNotification).pipe(Effect.result);
        if (decoded._tag === "Failure") {
          yield* logDroidWarning("Unable to decode Droid session notification", {
            error: decoded.failure,
          });
          return;
        }
        if (
          decoded.success.type === "agent_turn_completed" &&
          decoded.success.turnId === undefined
        ) {
          return yield* new DroidRpcError({
            kind: "protocol",
            rpcMessage: "Droid agent_turn_completed notification is missing turnId",
          });
        }
        const envelope = {
          sessionId:
            typeof message.params.sessionId === "string" ? message.params.sessionId : undefined,
          notification: decoded.success,
        } satisfies DroidNotificationEnvelope;
        if (
          lossyNotificationTypes.has(envelope.notification.type) &&
          Queue.sizeUnsafe(notifications) >= lossyNotificationQueueLimit
        ) {
          const droppedCount = yield* Ref.updateAndGet(
            droppedLossyNotificationCount,
            (count) => count + 1,
          );
          if (droppedCount === 1 || droppedCount % notificationQueueCapacity === 0) {
            yield* logDroidWarning(
              `Dropped ${droppedCount} lossy Droid session notifications because the delivery queue is saturated`,
            );
          }
          return;
        }
        yield* offerLossless(
          "notifications",
          notifications,
          notificationBacklog,
          notificationBacklogMutex,
          { encodedBytes, value: envelope },
          notificationQueueCapacity,
        );
      });

    const handleMessage = (message: JsonRpcMessage, encodedBytes: number) => {
      switch (message.type) {
        case "request":
          return handleServerRequest(message, encodedBytes);
        case "notification":
          return handleNotification(message, encodedBytes);
        case "response":
          return resolveResponse(message);
      }
    };

    const handleLine = (framed: FramedLine): Effect.Effect<void, DroidRpcError> => {
      if (framed.line.trim().length === 0) return Effect.void;
      return decodeJsonRpcMessage(framed.line).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            logDroidWarning("Unable to parse Droid JSON-RPC line", {
              error: cause,
              details: { lineBytes: framed.bytes },
            }),
          onSuccess: (message) => handleMessage(message, framed.bytes),
        }),
      );
    };

    const acceptChunk = (chunk: string) =>
      SynchronizedRef.modifyEffect(framing, (state) =>
        consumeChunk(state, chunk, maxMessageBytes, handleLine).pipe(
          Effect.map((next) => [undefined, next] as const),
        ),
      );

    const endInput = SynchronizedRef.modifyEffect(framing, (state) => {
      if (state.remainder.length === 0) {
        return Effect.succeed([undefined, state] as const);
      }
      const framed = {
        line: state.remainder,
        bytes: state.bytes,
      } satisfies FramedLine;
      return handleLine(framed).pipe(
        Effect.as([
          undefined,
          {
            remainder: "",
            bytes: 0,
          },
        ] as const),
      );
    });

    const beginShutdown = (exit?: DroidProcessExit) =>
      SynchronizedRef.modify(lifecycle, (state) => {
        if (state._tag !== "Running") return [false, state] as const;
        return [
          true,
          {
            _tag: "ShuttingDown",
            pending: state.pending,
            ...(exit === undefined ? {} : { exit }),
          },
        ] as const;
      });

    const handleExit = (exit: DroidProcessExit) =>
      SynchronizedRef.modify(lifecycle, (state) => {
        if (state._tag === "Exited") return [undefined, state] as const;
        const finalExit =
          state._tag === "ShuttingDown" && state.exit !== undefined ? state.exit : exit;
        const pending = Array.from(state.pending.entries()).filter(
          (entry): entry is [string, PendingRequest] => entry[1]._tag === "Pending",
        );
        return [
          { finalExit, pending },
          { _tag: "Exited", exit: finalExit },
        ] as const;
      }).pipe(
        Effect.flatMap((transition) =>
          transition === undefined
            ? Effect.void
            : Effect.forEach(
                transition.pending,
                ([requestId, request]) =>
                  Deferred.fail(
                    request.deferred,
                    processExitError(transition.finalExit, request.method, requestId),
                  ),
                { discard: true },
              ),
        ),
        Effect.andThen(
          Effect.all([Queue.end(outgoing), Queue.end(notifications), Queue.end(serverRequests)], {
            discard: true,
          }),
        ),
      );

    const request: DroidRpcProtocol["request"] = (method, params, options) =>
      Effect.gen(function* () {
        const requestId = String(yield* Ref.updateAndGet(nextRequestId, (id) => id + 1));
        const deferred = yield* Deferred.make<unknown, DroidRpcError>();
        yield* SynchronizedRef.modifyEffect(lifecycle, (state) => {
          if (state._tag === "Running") {
            const next = new Map(state.pending);
            next.set(requestId, { _tag: "Pending", method, deferred, sent: false });
            return Effect.succeed([undefined, { ...state, pending: next }] as const);
          }
          const exit =
            state._tag === "Exited"
              ? state.exit
              : (state.exit ??
                ({
                  code: null,
                  description: "Droid process is shutting down",
                } satisfies DroidProcessExit));
          return Effect.fail(processExitError(exit, method));
        });
        const timeoutMs =
          options === undefined ? DROID_SESSION_REQUEST_TIMEOUT_MS : options.timeoutMs;
        const exchange = writeEnvelope(
          {
            jsonrpc: "2.0",
            type: "request",
            factoryApiVersion,
            factoryProtocolVersion,
            id: requestId,
            method,
            params,
          },
          { requestId, deferred },
        ).pipe(Effect.andThen(Deferred.await(deferred)));
        const result =
          timeoutMs === undefined
            ? exchange
            : exchange.pipe(
                Effect.timeoutOption(Duration.millis(timeoutMs)),
                Effect.flatMap(
                  Option.match({
                    onSome: Effect.succeed,
                    onNone: () =>
                      SynchronizedRef.modify(lifecycle, (state) => {
                        if (state._tag === "Exited") return [false, state] as const;
                        const entry = state.pending.get(requestId);
                        if (
                          entry === undefined ||
                          entry._tag !== "Pending" ||
                          entry.deferred !== deferred
                        ) {
                          return [false, state] as const;
                        }
                        if (entry.sent) {
                          return [
                            true,
                            {
                              ...state,
                              pending: markRequestTimedOut(
                                state.pending,
                                requestId,
                                method,
                                requestTombstoneLimit,
                              ),
                            },
                          ] as const;
                        }
                        const next = new Map(state.pending);
                        next.delete(requestId);
                        return [true, { ...state, pending: next }] as const;
                      }).pipe(
                        Effect.flatMap((markedTimedOut) =>
                          markedTimedOut
                            ? Effect.fail(
                                new DroidRpcError({
                                  kind: "timeout",
                                  method,
                                  requestId,
                                  timeoutMs,
                                }),
                              )
                            : Deferred.await(deferred),
                        ),
                      ),
                  }),
                ),
              );
        return yield* result.pipe(
          Effect.ensuring(
            SynchronizedRef.update(lifecycle, (state) => {
              if (state._tag === "Exited") return state;
              const entry = state.pending.get(requestId);
              if (entry === undefined || entry._tag !== "Pending" || entry.deferred !== deferred) {
                return state;
              }
              const next = new Map(state.pending);
              next.delete(requestId);
              return { ...state, pending: next };
            }),
          ),
        );
      });

    const deliveryStream = <A>(
      queue: Queue.Queue<QueuedDelivery<A>, Cause.Done<void>>,
      backlogState: Ref.Ref<LosslessBacklogState>,
      backlogMutex: Semaphore.Semaphore,
    ) => {
      const takeDelivery: Effect.Effect<QueuedDelivery<A>, Cause.Done<void>> = Effect.suspend(() =>
        Queue.peek(queue).pipe(
          Effect.andThen(
            backlogMutex.withPermits(1)(
              Effect.uninterruptible(
                Queue.poll(queue).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.succeed(Option.none<QueuedDelivery<A>>()),
                      onSome: (delivery) =>
                        Ref.update(backlogState, (current) => ({
                          items: Math.max(0, current.items - 1),
                          bytes: Math.max(0, current.bytes - delivery.encodedBytes),
                        })).pipe(Effect.as(Option.some(delivery))),
                    }),
                  ),
                ),
              ),
            ),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () => takeDelivery,
              onSome: Effect.succeed,
            }),
          ),
        ),
      );
      return Stream.fromPull(
        Effect.succeed(takeDelivery.pipe(Effect.map((delivery) => Arr.of(delivery.value)))),
      );
    };

    return {
      request,
      notifications: deliveryStream(notifications, notificationBacklog, notificationBacklogMutex),
      serverRequests: deliveryStream(
        serverRequests,
        serverRequestBacklog,
        serverRequestBacklogMutex,
      ),
      latestServerRequestSequence: Ref.get(nextServerRequestSequence),
      outgoing: Stream.fromQueue(outgoing).pipe(
        Stream.filterMapEffect((frame): Effect.Effect<Result.Result<string, void>> => {
          if (frame._tag === "Uncorrelated") return Effect.succeed(Result.succeed(frame.encoded));
          return SynchronizedRef.modify(
            lifecycle,
            (state): readonly [Result.Result<string, void>, DroidRpcLifecycle] => {
              if (state._tag === "Exited") return [Result.fail(undefined), state] as const;
              const entry = state.pending.get(frame.requestId);
              if (
                entry === undefined ||
                entry._tag !== "Pending" ||
                entry.deferred !== frame.deferred
              ) {
                return [Result.fail(undefined), state] as const;
              }
              const next = new Map(state.pending);
              next.set(frame.requestId, { ...entry, sent: true });
              return [Result.succeed(frame.encoded), { ...state, pending: next }] as const;
            },
          );
        }),
      ),
      acceptChunk,
      endInput,
      beginShutdown,
      closeOutgoing: Queue.end(outgoing),
      handleExit,
    } satisfies DroidRpcProtocol;
  });
