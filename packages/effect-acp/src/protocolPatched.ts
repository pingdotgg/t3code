import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";

import { CLIENT_METHODS } from "./_generated/meta.gen.ts";
import * as AcpError from "./errors.ts";
import {
  decodeElicitationComplete,
  decodeFailureDiagnostics,
  decodeSessionUpdate,
  encodeJsonRpcNotification,
  isEffectRpcRequestId,
  isProtocolError,
  MAX_BUFFERED_RAW_NOTIFICATIONS,
  makeStrictNdJsonRpcParser,
  normalizeAcpJsonRpcError,
  parserFactory,
} from "./protocolCodec.ts";
import {
  acknowledgeOutgoingWrite,
  completeOutgoingWrites,
  failOutgoingWrites,
  type AcpOutgoingWrite,
  type AcpOutgoingWriterState,
} from "./protocolWrites.ts";
import { isolateNotificationHandler } from "./_internal/shared.ts";
import { makeAcpExtPendingOps } from "./protocolExtPending.ts";
import { acpRequestIdentity } from "./protocolIdentity.ts";
import type {
  AcpIncomingNotification,
  AcpPatchedProtocol,
  AcpPatchedProtocolOptions,
  AcpProtocolLogEvent,
} from "./protocol.ts";
import type { AcpPendingRequest } from "./protocolExtPending.ts";

const isAcpError = Schema.is(AcpError.AcpError);

/**
 * First id for typed Effect RPC requests. Starts within signed int32 for SDKs that reject
 * larger numeric ids (e.g. the Kotlin ACP SDK decodes ids as `Int`), while staying far
 * above extension ids, which count up from 1.
 */
export const RPC_REQUEST_ID_START = 2 ** 30;



export const makeAcpPatchedProtocol = Effect.fn("makeAcpPatchedProtocol")(function* (
  options: AcpPatchedProtocolOptions,
): Effect.fn.Return<AcpPatchedProtocol, never, Scope.Scope> {
  const parser = makeStrictNdJsonRpcParser();
  const serverQueue = yield* Queue.unbounded<RpcMessage.FromClientEncoded>();
  const clientQueue = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
  const notificationQueue = yield* Queue.sliding<AcpIncomingNotification>(
    MAX_BUFFERED_RAW_NOTIFICATIONS,
  );
  const disconnects = yield* Queue.unbounded<number>();
  const outgoing = yield* Queue.unbounded<AcpOutgoingWrite, AcpError.AcpError | Cause.Done<void>>();
  const outgoingWriterState = yield* Ref.make<AcpOutgoingWriterState>({
    intentionalEnd: false,
    outstandingAcknowledgements: new Set(),
  });
  const nextRequestId = yield* Ref.make(1);
  const warnedDecodeFailures = new Set<string>();
  const terminationHandled = yield* Ref.make(false);
  const terminationFailure = yield* Deferred.make<never, AcpError.AcpError>();
  const extPending = yield* Ref.make(new Map<string, AcpPendingRequest>());
  const extPendingOps = makeAcpExtPendingOps(extPending);
  const removeExtPending = extPendingOps.remove;
  const completeExtPendingFailure = extPendingOps.completeFailure;
  const completeExtPendingSuccess = extPendingOps.completeSuccess;
  const failAllExtPending = extPendingOps.failAll;

  const ensureActive = Ref.get(terminationHandled).pipe(
    Effect.flatMap((terminated) => (terminated ? Deferred.await(terminationFailure) : Effect.void)),
  );

  const logProtocol = (event: AcpProtocolLogEvent) => {
    if (event.direction === "incoming" && !options.logIncoming) {
      return Effect.void;
    }
    if (event.direction === "outgoing" && !options.logOutgoing) {
      return Effect.void;
    }
    return (
      options.logger?.(event) ??
      Effect.logDebug("ACP protocol event").pipe(Effect.annotateLogs({ event }))
    );
  };

  const offerOutgoing = Effect.fn("offerOutgoing")(function* (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ) {
    // RpcClient emits `@effect/rpc/Interrupt` when a pending request's fiber is interrupted.
    // ACP has no such method; agents log it as an error and cannot act on it, so drop it.
    if (message._tag === "Interrupt") {
      return;
    }
    yield* ensureActive;
    yield* logProtocol({
      direction: "outgoing",
      stage: "decoded",
      payload: message,
    });

    const method = message._tag === "Request" ? message.tag : undefined;
    const encodedRequestId =
      message._tag === "Request"
        ? message.id
        : "requestId" in message
          ? message.requestId
          : undefined;
    const requestId = encodedRequestId === "" ? undefined : encodedRequestId;
    const encoded = yield* Effect.try({
      try: () => parser.encode(message),
      catch: (cause) => AcpError.AcpProtocolParseError.fromEncodingError(method, requestId, cause),
    });

    if (encoded) {
      yield* logProtocol({
        direction: "outgoing",
        stage: "raw",
        payload: typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded),
      });

      yield* ensureActive;
      const acknowledgement =
        message._tag === "Exit" ? yield* Deferred.make<void, AcpError.AcpError>() : undefined;
      const admissionError = yield* Ref.modify(outgoingWriterState, (state) => {
        if (state.terminalError !== undefined) {
          return [state.terminalError, state] as const;
        }
        if (acknowledgement === undefined) {
          return [undefined, state] as const;
        }
        return [
          undefined,
          {
            ...state,
            outstandingAcknowledgements: new Set(state.outstandingAcknowledgements).add(
              acknowledgement,
            ),
          },
        ] as const;
      });
      if (admissionError !== undefined) {
        return yield* admissionError;
      }
      if (options.testHooks?.onOutgoingWriteAdmitted !== undefined) {
        yield* options.testHooks.onOutgoingWriteAdmitted();
      }
      yield* Queue.offer(outgoing, {
        payload: encoded,
        ...(acknowledgement === undefined ? {} : { acknowledgement }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AcpError.AcpTransportError({
              detail: "Failed to queue an outgoing ACP message",
              cause,
            }),
        ),
        Effect.filterOrFail(
          (accepted) => accepted,
          () =>
            new AcpError.AcpTransportError({
              detail: "The ACP output queue was closed before accepting a message",
              cause: "Output queue closed",
            }),
        ),
        Effect.tapError((error) =>
          acknowledgement === undefined
            ? Effect.void
            : Ref.update(outgoingWriterState, (state) => {
                const updated = new Set(state.outstandingAcknowledgements);
                updated.delete(acknowledgement);
                return { ...state, outstandingAcknowledgements: updated };
              }).pipe(Effect.andThen(Deferred.fail(acknowledgement, error)), Effect.asVoid),
        ),
      );
      if (acknowledgement !== undefined) {
        yield* Deferred.await(acknowledgement);
      }
      if (message._tag === "Exit" && options.onOutgoingResponse !== undefined) {
        yield* options.onOutgoingResponse(acpRequestIdentity(message.requestId));
      }
    }
  });

  const dispatchNotification = (notification: AcpIncomingNotification) =>
    Queue.offer(notificationQueue, notification).pipe(
      Effect.andThen(
        // A failing or dying handler must not stop the reader, or every later
        // message on the connection goes unanswered.
        options.onNotification
          ? isolateNotificationHandler(options.onNotification(notification))
          : Effect.void,
      ),
      Effect.asVoid,
    );

  const emitClientProtocolError = (error: AcpError.AcpError) =>
    Queue.offer(clientQueue, {
      _tag: "ClientProtocolError",
      error: new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({
          message: "ACP protocol terminated.",
          cause: error,
        }),
      }),
    }).pipe(Effect.asVoid);

  const handleTermination = (classify: () => Effect.Effect<AcpError.AcpError>) =>
    Ref.modify(terminationHandled, (handled) => {
      if (handled) {
        return [Effect.void, true] as const;
      }
      return [
        Effect.gen(function* () {
          yield* Queue.offer(disconnects, 0);
          const error = yield* classify();
          yield* Deferred.fail(terminationFailure, error);
          yield* failAllExtPending(error);
          yield* emitClientProtocolError(error);
          if (options.onTermination) {
            yield* options.onTermination(error);
          }
        }),
        true,
      ] as const;
    }).pipe(Effect.flatten);

  const respondWithSuccess = (requestId: AcpError.AcpRequestId, value: unknown) =>
    offerOutgoing({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Success",
        value,
      },
    });

  const respondWithError = (requestId: AcpError.AcpRequestId, error: AcpError.AcpRequestError) =>
    offerOutgoing({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: error.toProtocolError(),
          },
        ],
      },
    });

  const handleExtRequest = (message: RpcMessage.RequestEncoded) => {
    if (!options.onExtRequest) {
      return respondWithError(message.id, AcpError.AcpRequestError.methodNotFound(message.tag));
    }
    return options
      .onExtRequest(message.tag, message.payload, {
        requestId: acpRequestIdentity(message.id),
        method: message.tag,
      })
      .pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => {
            const failure = Cause.hasDies(cause) ? Option.none() : Cause.findErrorOption(cause);
            if (Option.isSome(failure)) {
              return respondWithError(
                message.id,
                AcpError.AcpRequestError.fromExtensionHandlerError(failure.value, message.tag),
              );
            }
            return Effect.logError(
              `ACP extension request handler failed for '${message.tag}'`,
              cause,
            ).pipe(
              Effect.andThen(
                respondWithError(
                  message.id,
                  AcpError.AcpRequestError.internalError(
                    `ACP extension request handler failed for method '${message.tag}'`,
                    undefined,
                    {
                      method: message.tag,
                      operation: "handle-extension-request",
                      cause: Cause.squash(cause),
                    },
                  ),
                ),
              ),
            );
          },
          onSuccess: (value) => respondWithSuccess(message.id, value),
        }),
      );
  };

  // Drop undecodable notifications without ending working sessions; newer specs may add unknown shapes.
  // Warn once per distinct failure per connection because agents repeat bad payloads.
  const dropUndecodableNotification = (method: string) => (cause: Schema.SchemaError) => {
    const error = AcpError.AcpProtocolParseError.fromSchemaError(
      "decode-notification-payload",
      method,
      cause,
    );
    const diagnostics = decodeFailureDiagnostics(error);
    const key = `${method}\n${error.issueSummary}`;
    const firstOfItsKind = !warnedDecodeFailures.has(key);
    warnedDecodeFailures.add(key);
    return logProtocol({
      direction: "incoming",
      stage: "decode_failed",
      payload: diagnostics,
    }).pipe(
      Effect.andThen(
        firstOfItsKind
          ? Effect.logWarning("Dropped an ACP notification that failed to decode").pipe(
              Effect.annotateLogs(diagnostics),
            )
          : Effect.void,
      ),
    );
  };

  const handleRequestEncoded = (message: RpcMessage.RequestEncoded) => {
    if (message.id === "") {
      if (message.tag === CLIENT_METHODS.session_update) {
        return decodeSessionUpdate(message.payload).pipe(
          Effect.matchEffect({
            onFailure: dropUndecodableNotification(CLIENT_METHODS.session_update),
            onSuccess: (params) =>
              dispatchNotification({
                _tag: "SessionUpdate",
                method: CLIENT_METHODS.session_update,
                params: options.transformSessionUpdate?.(params) ?? params,
              }),
          }),
        );
      }
      if (
        message.tag === CLIENT_METHODS.elicitation_complete ||
        message.tag === "session/elicitation/complete"
      ) {
        const method = message.tag;
        return decodeElicitationComplete(message.payload).pipe(
          Effect.matchEffect({
            onFailure: dropUndecodableNotification(method),
            onSuccess: (params) =>
              dispatchNotification({ _tag: "ElicitationComplete", method, params }),
          }),
        );
      }
      return dispatchNotification({
        _tag: "ExtNotification",
        method: message.tag,
        params: message.payload,
      });
    }

    const observeIncoming =
      options.onIncomingRequest?.(acpRequestIdentity(message.id), message.tag, message.payload) ??
      Effect.void;

    if (!options.serverRequestMethods.has(message.tag)) {
      return observeIncoming.pipe(
        Effect.andThen(handleExtRequest(message)),
        Effect.catchTags({
          AcpProtocolParseError: (error) =>
            Effect.logWarning(error).pipe(
              Effect.annotateLogs({
                method: message.tag,
                requestId: message.id,
                operation: error.operation,
              }),
              Effect.andThen(
                respondWithError(
                  message.id,
                  AcpError.AcpRequestError.fromExtensionResponseEncodingError(
                    message.tag,
                    message.id,
                    error,
                  ),
                ),
              ),
            ),
        }),
        Effect.asVoid,
      );
    }

    return observeIncoming.pipe(Effect.andThen(Queue.offer(serverQueue, message)), Effect.asVoid);
  };

  const forwardToRpcClient = (
    message: RpcMessage.ResponseChunkEncoded | RpcMessage.ResponseExitEncoded,
  ) =>
    isEffectRpcRequestId(message.requestId)
      ? Queue.offer(clientQueue, message).pipe(Effect.asVoid)
      : Effect.void;

  const handleExitEncoded = (message: RpcMessage.ResponseExitEncoded) =>
    Ref.get(extPending).pipe(
      Effect.flatMap((pending) => {
        const pendingRequest = pending.get(acpRequestIdentity(message.requestId));
        if (!pendingRequest) {
          return forwardToRpcClient(message);
        }
        if (message.exit._tag === "Success") {
          return completeExtPendingSuccess(message.requestId, message.exit.value);
        }
        const failure = message.exit.cause.find((entry) => entry._tag === "Fail");
        if (failure && isProtocolError(failure.error)) {
          return completeExtPendingFailure(
            message.requestId,
            AcpError.AcpRequestError.fromProtocolError(failure.error, {
              method: pendingRequest.method,
              requestId: message.requestId,
              cause: message.exit.cause,
            }),
          );
        }
        return completeExtPendingFailure(
          message.requestId,
          AcpError.AcpRequestError.fromExtensionResponseFailure(
            pendingRequest.method,
            message.requestId,
            message.exit.cause,
          ),
        );
      }),
    );

  const routeDecodedMessage = (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ): Effect.Effect<void, AcpError.AcpError> => {
    switch (message._tag) {
      case "Request":
        return handleRequestEncoded(message);
      case "Exit":
        return handleExitEncoded(message);
      case "Chunk":
        return Ref.get(extPending).pipe(
          Effect.flatMap((pending) => {
            const pendingRequest = pending.get(acpRequestIdentity(message.requestId));
            return pendingRequest
              ? completeExtPendingFailure(
                  message.requestId,
                  AcpError.AcpRequestError.unsupportedStreamingResponse(
                    pendingRequest.method,
                    message.requestId,
                  ),
                )
              : forwardToRpcClient(message);
          }),
        );
      case "Defect":
      case "ClientProtocolError":
      case "Pong":
        return Queue.offer(clientQueue, message).pipe(Effect.asVoid);
      case "Ack":
      case "Interrupt":
      case "Ping":
      case "Eof":
        return Queue.offer(serverQueue, message).pipe(Effect.asVoid);
    }
  };

  yield* options.stdio.stdin.pipe(
    Stream.runForEach((data) =>
      (options.logIncoming
        ? logProtocol({
            direction: "incoming",
            stage: "raw",
            payload: typeof data === "string" ? data : new TextDecoder().decode(data),
          })
        : Effect.void
      ).pipe(
        Effect.flatMap(() =>
          Effect.try({
            try: () =>
              (
                parser.decode(data) as ReadonlyArray<
                  RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded
                >
              ).map(normalizeAcpJsonRpcError),
            catch: (cause) =>
              new AcpError.AcpProtocolParseError({
                operation: "decode-wire-message",
                cause,
              }),
          }),
        ),
        Effect.tap((messages) =>
          logProtocol({
            direction: "incoming",
            stage: "decoded",
            payload: messages,
          }),
        ),
        Effect.tapErrorTag("AcpProtocolParseError", (error) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: decodeFailureDiagnostics(error),
          }),
        ),
        Effect.flatMap((messages) =>
          Effect.forEach(messages, routeDecodedMessage, {
            discard: true,
          }),
        ),
      ),
    ),
    Effect.andThen(
      Effect.suspend(() =>
        Effect.forEach(
          (
            parser.end() as ReadonlyArray<
              RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded
            >
          ).map(normalizeAcpJsonRpcError),
          routeDecodedMessage,
          { discard: true },
        ),
      ),
    ),
    // Anything that ends the reader, including a defect in a callback it runs,
    // terminates the connection so pending requests fail instead of hanging.
    Effect.matchCauseEffect({
      onFailure: (cause) => {
        const failure = Cause.findErrorOption(cause);
        const error = Option.isSome(failure) ? failure.value : Cause.squash(cause);
        const normalized: AcpError.AcpError = isAcpError(error)
          ? error
          : new AcpError.AcpTransportError({
              operation: "read-input-stream",
              cause: error,
            });
        return handleTermination(() => Effect.succeed(normalized));
      },
      onSuccess: () =>
        handleTermination(() => {
          const ended = new AcpError.AcpInputStreamEndedError({});
          if (!options.terminationError) return Effect.succeed(ended);
          // Stdout can close without process exit; use a live-clock diagnostic grace period.
          return options.terminationError.pipe(
            Effect.timeoutOption("250 millis"),
            Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
            Effect.map(Option.getOrElse(() => ended)),
          );
        }),
    }),
    Effect.forkScoped,
  );

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.flatMap((write) => {
      const acknowledgement = write.acknowledgement;
      const completion =
        acknowledgement === undefined
          ? Stream.empty
          : Stream.fromEffect(acknowledgeOutgoingWrite(outgoingWriterState, acknowledgement)).pipe(Stream.drain);
      return Stream.make(write.payload).pipe(Stream.concat(completion));
    }),
    Stream.run(options.stdio.stdout()),
    Effect.onExit((exit) =>
      Exit.match(exit, {
        onFailure: (cause) => {
          const error = new AcpError.AcpTransportError({
            detail: Cause.hasInterruptsOnly(cause)
              ? "The ACP output writer was interrupted while closing"
              : "Failed to write an outgoing ACP message",
            cause,
          });
          return failOutgoingWrites(outgoingWriterState, outgoing, error).pipe(
            Effect.andThen(
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : handleTermination(() => Effect.succeed(error)),
            ),
          );
        },
        onSuccess: () =>
          Ref.get(outgoingWriterState).pipe(
            Effect.flatMap((state) => {
              const handled = state.intentionalEnd
                ? completeOutgoingWrites(outgoingWriterState)
                : (() => {
                    const error = new AcpError.AcpTransportError({
                      detail: "ACP output writer ended before the protocol closed",
                      cause: "Output writer ended",
                    });
                    return failOutgoingWrites(outgoingWriterState, outgoing, error).pipe(
                      Effect.andThen(handleTermination(() => Effect.succeed(error))),
                    );
                  })();
              return handled.pipe(
                Effect.andThen(
                  options.testHooks?.onOutgoingWriterExit === undefined
                    ? Effect.void
                    : options.testHooks.onOutgoingWriterExit({
                        intentionalEnd: state.intentionalEnd,
                      }),
                ),
              );
            }),
          ),
      }),
    ),
    Effect.forkScoped,
  );

  // Protocol loops and per-message sends share the caller's operation span.
  const clientProtocol = RpcClient.Protocol.of({
    run: Effect.fnUntraced(function* (_clientId, f) {
      return yield* Stream.fromQueue(clientQueue).pipe(
        Stream.runForEach((message) => f(message)),
        Effect.forever,
      );
    }),
    send: Effect.fnUntraced(function* (_clientId, request) {
      return yield* offerOutgoing(request).pipe(
        Effect.mapError(
          (error) =>
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "Failed to send ACP protocol message.",
                cause: error,
              }),
            }),
        ),
      );
    }),
    supportsAck: true,
    supportsTransferables: false,
    codecFor: parserFactory.codecFor,
  });

  const serverProtocol = RpcServer.Protocol.of({
    run: Effect.fnUntraced(function* (f) {
      return yield* Stream.fromQueue(serverQueue).pipe(
        Stream.runForEach((message) => f(0, message)),
        Effect.forever,
      );
    }),
    disconnects,
    send: Effect.fnUntraced(function* (_clientId, response) {
      return yield* offerOutgoing(response).pipe(
        Effect.tapError((error) =>
          response._tag === "Exit" && options.onOutgoingResponseFailure !== undefined
            ? options.onOutgoingResponseFailure(acpRequestIdentity(response.requestId), error)
            : Effect.void,
        ),
        Effect.orDie,
      );
    }),
    end: Effect.fn("RpcServer.Protocol.end")(function (_clientId) {
      return Ref.update(outgoingWriterState, (state) => ({ ...state, intentionalEnd: true })).pipe(
        Effect.andThen(Queue.end(outgoing)),
      );
    }),
    clientIds: Effect.succeed(new Set([0])),
    initialMessage: Effect.succeedNone,
    supportsAck: true,
    supportsTransferables: false,
    codecFor: parserFactory.codecFor,
    supportsSpanPropagation: true,
    supportsNotifications: true,
  });

  // JSON-RPC notifications carry no `id`. Encoding a Request without `isNotification`
  // emits an `id`, which real agents (Grok CLI) parse as a malformed request and silently drop.
  const sendNotification = Effect.fn("sendNotification")(function* (
    method: string,
    payload: unknown,
  ) {
    yield* ensureActive;
    yield* logProtocol({
      direction: "outgoing",
      stage: "decoded",
      payload: { _tag: "Notification", tag: method, payload },
    });
    const exit = encodeJsonRpcNotification({ jsonrpc: "2.0", method, params: payload });
    if (Exit.isFailure(exit)) {
      return yield* AcpError.AcpProtocolParseError.fromEncodingError(
        method,
        undefined,
        Cause.squash(exit.cause),
      );
    }
    const encoded = `${exit.value}\n`;
    yield* logProtocol({ direction: "outgoing", stage: "raw", payload: encoded });
    yield* ensureActive;
    // FIFO queue admission preserves wire ordering against later requests
    // (a session/prompt sent after session/cancel cannot overtake it).
    yield* Queue.offer(outgoing, { payload: encoded }).pipe(
      Effect.mapError(
        (cause) =>
          new AcpError.AcpTransportError({
            detail: "Failed to queue an outgoing ACP notification",
            cause,
          }),
      ),
      Effect.filterOrFail(
        (accepted) => accepted,
        () =>
          new AcpError.AcpTransportError({
            detail: "The ACP output queue was closed before accepting a notification",
            cause: "Output queue closed",
          }),
      ),
    );
  });

  const sendRequest = Effect.fn("sendRequest")(function* (method: string, payload: unknown) {
    yield* ensureActive;
    const requestId = yield* Ref.modify(
      nextRequestId,
      (current) => [current, current + 1] as const,
    );
    const deferred = yield* Deferred.make<unknown, AcpError.AcpError>();
    yield* Ref.update(extPending, (pending) =>
      new Map(pending).set(acpRequestIdentity(requestId), { deferred, method }),
    );
    yield* offerOutgoing({
      _tag: "Request",
      id: requestId,
      tag: method,
      payload,
      headers: [],
    }).pipe(Effect.tapError(() => removeExtPending(requestId)));
    return yield* Deferred.await(deferred).pipe(
      Effect.onInterrupt(() => removeExtPending(requestId)),
    );
  });

  return {
    clientProtocol,
    serverProtocol,
    get incoming() {
      return Stream.fromQueue(notificationQueue);
    },
    request: sendRequest,
    notify: sendNotification,
  } satisfies AcpPatchedProtocol;
});
