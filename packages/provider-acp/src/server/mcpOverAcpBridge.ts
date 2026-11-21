// @effect-diagnostics globalJsonInEffect:off
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as AcpSchema from "effect-acp/compat";

import { responsePayloads } from "@t3tools/shared/mcpResponsePayloads";

const MAX_CONNECTIONS = 16;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
// Runtime teardown waits on disconnect, so an endpoint that never answers must not hold it.
const DISCONNECT_TIMEOUT = "5 seconds";

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

interface Connection {
  readonly mutex: Semaphore.Semaphore;
  sessionId: string | null;
  protocolVersion: string | null;
  initializeParams: unknown;
  hasInitialized: boolean;
  needsReconnect: boolean;
  nextRequestId: number;
}

export class AcpMcpOverAcpError extends Schema.TaggedError<AcpMcpOverAcpError>()(
  "AcpMcpOverAcpError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const isAcpMcpOverAcpError = Schema.is(AcpMcpOverAcpError);

const bridgeError = (cause: unknown): AcpMcpOverAcpError =>
  isAcpMcpOverAcpError(cause)
    ? cause
    : new AcpMcpOverAcpError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const asEnvelope = (value: unknown): JsonRpcEnvelope | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRpcEnvelope)
    : null;

function protocolVersionOf(payload: unknown): string | null {
  const result = asEnvelope(payload)?.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const protocolVersion = (result as { readonly protocolVersion?: unknown }).protocolVersion;
  return typeof protocolVersion === "string" && protocolVersion.length > 0 ? protocolVersion : null;
}

function errorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return "The MCP server returned an error.";
  }
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" && message.length > 0
    ? message
    : "The MCP server returned an error.";
}

export interface AcpMcpOverAcpBridgeOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly allocateConnectionId: Effect.Effect<string>;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface AcpMcpOverAcpBridge {
  readonly connect: (
    request: AcpSchema.ConnectMcpRequest,
  ) => Effect.Effect<AcpSchema.ConnectMcpResponse, AcpMcpOverAcpError>;
  readonly message: (
    request: AcpSchema.MessageMcpRequest,
  ) => Effect.Effect<AcpSchema.MessageMcpResponse, AcpMcpOverAcpError>;
  readonly notification: (
    request: AcpSchema.MessageMcpNotification,
  ) => Effect.Effect<void, AcpMcpOverAcpError>;
  readonly disconnect: (
    request: AcpSchema.DisconnectMcpRequest,
  ) => Effect.Effect<AcpSchema.DisconnectMcpResponse, AcpMcpOverAcpError>;
  /** Updates the Bearer header for future requests; in-flight calls keep the header they started with. */
  readonly setAuthorization: (authorization: string) => void;
  /** Fails every call in flight, so Stop releases their HTTP responses. */
  readonly stopCalls: Effect.Effect<void>;
  readonly dispose: Effect.Effect<void>;
}

export const makeAcpMcpOverAcpBridge = Effect.fn("AcpMcpOverAcpBridge.make")(function* (
  options: AcpMcpOverAcpBridgeOptions,
): Effect.fn.Return<AcpMcpOverAcpBridge> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let authorization = options.authorization;
  let authorizationGeneration = 0;
  const connections = yield* Effect.sync(() => new Map<string, Connection>());
  let callsStopped = yield* Deferred.make<void>();

  const connectionFor = (connectionId: string): Effect.Effect<Connection, AcpMcpOverAcpError> =>
    Effect.suspend(() => {
      const connection = connections.get(connectionId);
      return connection === undefined
        ? Effect.fail(
            new AcpMcpOverAcpError({
              message: `Unknown MCP-over-ACP connection "${connectionId}".`,
            }),
          )
        : Effect.succeed(connection);
    });

  // Only initialization and auth-rotation reconnects need ordering; negotiated calls wait independently.
  const untilNegotiated = <A, E>(connection: Connection, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() =>
      connection.protocolVersion === null || connection.needsReconnect
        ? connection.mutex.withPermits(1)(effect)
        : effect,
    );

  const postOnce = Effect.fn("AcpMcpOverAcpBridge.postOnce")(function* (
    connection: Connection,
    message: unknown,
    requestAuthorization: string,
    requestGeneration: number,
    requestSessionId: string | null,
    requestProtocolVersion: string | null,
  ) {
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) {
      return yield* new AcpMcpOverAcpError({ message: "MCP-over-ACP message exceeds 8 MiB." });
    }
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetchImplementation(options.endpoint, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: requestAuthorization,
            ...(requestSessionId === null ? {} : { "mcp-session-id": requestSessionId }),
            ...(requestProtocolVersion === null
              ? {}
              : { "mcp-protocol-version": requestProtocolVersion }),
          },
          body,
        }),
      catch: bridgeError,
    });
    if (requestGeneration === authorizationGeneration) {
      connection.sessionId = response.headers.get("mcp-session-id") ?? connection.sessionId;
    }
    if (!response.ok) {
      yield* Effect.promise(
        () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
      );
      return yield* new AcpMcpOverAcpError({
        message: `T3 Code MCP endpoint responded with HTTP ${response.status}.`,
      });
    }
    const payloads = [...(yield* Stream.runCollect(responsePayloads(response, bridgeError)))];
    if (requestGeneration === authorizationGeneration) {
      for (const payload of payloads) {
        connection.protocolVersion = protocolVersionOf(payload) ?? connection.protocolVersion;
      }
    }
    return payloads;
  }, Effect.mapError(bridgeError));

  const reconnectIfNeeded = Effect.fn("AcpMcpOverAcpBridge.reconnectIfNeeded")(function* (
    connection: Connection,
    message: unknown,
  ) {
    const method = asEnvelope(message)?.method;
    if (!connection.needsReconnect || method === "initialize") return;
    const reconnectGeneration = authorizationGeneration;
    const reconnectAuth = authorization;
    const initId = ++connection.nextRequestId;
    const initPayloads = yield* postOnce(
      connection,
      {
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        ...(connection.initializeParams == null ? {} : { params: connection.initializeParams }),
      },
      reconnectAuth,
      reconnectGeneration,
      null,
      null,
    );
    const initEnvelope = asEnvelope(
      initPayloads.find((payload) => asEnvelope(payload)?.id === initId),
    );
    if (
      initEnvelope === null ||
      initEnvelope.error !== undefined ||
      protocolVersionOf(initEnvelope) === null
    ) {
      return yield* new AcpMcpOverAcpError({
        message:
          initEnvelope?.error !== undefined
            ? errorMessage(initEnvelope.error)
            : "MCP server did not return a valid initialize response during reconnect.",
      });
    }
    if (reconnectGeneration !== authorizationGeneration) return;
    yield* postOnce(
      connection,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      reconnectAuth,
      reconnectGeneration,
      connection.sessionId,
      connection.protocolVersion,
    );
    if (reconnectGeneration === authorizationGeneration) {
      connection.needsReconnect = false;
    }
  });

  const sendNow = (
    connection: Connection,
    message: unknown,
  ): Effect.Effect<ReadonlyArray<unknown>, AcpMcpOverAcpError> => {
    const method = asEnvelope(message)?.method;
    const pinnedGeneration = authorizationGeneration;
    return untilNegotiated(
      connection,
      Effect.gen(function* () {
        if (method !== "initialize") {
          while (connection.needsReconnect) {
            if (authorizationGeneration !== pinnedGeneration) {
              return yield* new AcpMcpOverAcpError({
                message: "MCP credentials rotated while the request was waiting to send.",
              });
            }
            yield* reconnectIfNeeded(connection, message);
          }
          if (authorizationGeneration !== pinnedGeneration) {
            return yield* new AcpMcpOverAcpError({
              message: "MCP credentials rotated while the request was waiting to send.",
            });
          }
        }
        const requestGeneration = authorizationGeneration;
        const requestAuthorization = authorization;
        const requestSessionId = method === "initialize" ? null : connection.sessionId;
        const requestProtocolVersion = method === "initialize" ? null : connection.protocolVersion;
        const payloads = yield* postOnce(
          connection,
          message,
          requestAuthorization,
          requestGeneration,
          requestSessionId,
          requestProtocolVersion,
        );
        if (method === "initialize") {
          const requestId = asEnvelope(message)?.id;
          const initEnvelope = asEnvelope(
            payloads.find((payload) => asEnvelope(payload)?.id === requestId),
          );
          if (
            initEnvelope !== null &&
            initEnvelope.error === undefined &&
            protocolVersionOf(initEnvelope) !== null
          ) {
            connection.hasInitialized = true;
            connection.needsReconnect = requestGeneration !== authorizationGeneration;
          }
        }
        return payloads;
      }),
    );
  };

  const send = (
    connection: Connection,
    message: unknown,
  ): Effect.Effect<ReadonlyArray<unknown>, AcpMcpOverAcpError> =>
    Effect.suspend(() =>
      Effect.raceFirst(
        sendNow(connection, message),
        Deferred.await(callsStopped).pipe(
          Effect.andThen(
            Effect.fail(new AcpMcpOverAcpError({ message: "The MCP call was stopped." })),
          ),
        ),
      ),
    );

  const disconnect = Effect.fn("mcpOverAcpBridge.disconnect")(function* (
    request: AcpSchema.DisconnectMcpRequest,
  ): Effect.fn.Return<AcpSchema.DisconnectMcpResponse, AcpMcpOverAcpError> {
    const connection = yield* connectionFor(request.connectionId);
    connections.delete(request.connectionId);
    const sessionId = connection.sessionId;
    const disconnectAuthorization = authorization;
    const disconnectGeneration = authorizationGeneration;
    if (sessionId !== null) {
      yield* Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetchImplementation(options.endpoint, {
              method: "DELETE",
              signal,
              headers: {
                authorization: disconnectAuthorization,
                "mcp-session-id": sessionId,
                ...(connection.protocolVersion === null
                  ? {}
                  : { "mcp-protocol-version": connection.protocolVersion }),
              },
            }),
          catch: bridgeError,
        });
        if (!response.ok && response.status !== 404) {
          return yield* new AcpMcpOverAcpError({
            message: `T3 Code MCP endpoint rejected disconnect with HTTP ${response.status}.`,
          });
        }
        yield* Effect.promise(
          () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: DISCONNECT_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new AcpMcpOverAcpError({
                message: "T3 Code MCP endpoint did not answer disconnect.",
              }),
            ),
        }),
        // Restore a session that failed to close, so a retry or dispose can close it. A rotation
        // during the DELETE missed this connection, so it reconnects instead of reusing the old session.
        Effect.onError(() =>
          Effect.sync(() => {
            if (disconnectGeneration !== authorizationGeneration) {
              connection.sessionId = null;
              connection.needsReconnect = connection.hasInitialized;
            }
            connections.set(request.connectionId, connection);
          }),
        ),
      );
    }
    return {};
  });

  return {
    connect: Effect.fn("mcpOverAcpBridge.connect")(function* (request) {
      if (request.serverId !== "t3-code") {
        return yield* new AcpMcpOverAcpError({
          message: `Unknown ACP MCP server "${request.serverId}".`,
        });
      }
      if (connections.size >= MAX_CONNECTIONS) {
        return yield* new AcpMcpOverAcpError({ message: "Too many MCP-over-ACP connections." });
      }
      const connectionId = yield* options.allocateConnectionId;
      connections.set(connectionId, {
        mutex: yield* Semaphore.make(1),
        sessionId: null,
        protocolVersion: null,
        initializeParams: undefined,
        hasInitialized: false,
        needsReconnect: false,
        nextRequestId: 0,
      });
      return { connectionId };
    }),
    message: Effect.fn("mcpOverAcpBridge.message")(function* (request) {
      const connection = yield* connectionFor(request.connectionId);
      if (request.method === "initialize") {
        connection.initializeParams = request.params;
      }
      const id = ++connection.nextRequestId;
      const payloads = yield* send(connection, {
        jsonrpc: "2.0",
        id,
        method: request.method,
        ...(request.params == null ? {} : { params: request.params }),
      });
      const response = payloads.find((payload) => asEnvelope(payload)?.id === id);
      const envelope = asEnvelope(response);
      if (envelope === null) {
        return yield* new AcpMcpOverAcpError({
          message: "MCP server did not return a matching response.",
        });
      }
      if (envelope.error !== undefined) {
        return yield* new AcpMcpOverAcpError({ message: errorMessage(envelope.error) });
      }
      if (request.method === "initialize" && protocolVersionOf(envelope) === null) {
        return yield* new AcpMcpOverAcpError({
          message: "MCP server did not return a valid initialize response.",
        });
      }
      return (envelope.result ?? null) as AcpSchema.MessageMcpResponse;
    }),
    notification: Effect.fn("mcpOverAcpBridge.notification")(function* (request) {
      const connection = yield* connectionFor(request.connectionId);
      yield* send(connection, {
        jsonrpc: "2.0",
        method: request.method,
        ...(request.params == null ? {} : { params: request.params }),
      });
    }),
    disconnect,
    setAuthorization: (nextAuthorization) => {
      if (nextAuthorization === authorization) return;
      authorization = nextAuthorization;
      authorizationGeneration += 1;
      for (const connection of connections.values()) {
        connection.sessionId = null;
        if (connection.hasInitialized) {
          connection.needsReconnect = true;
        }
      }
    },
    stopCalls: Effect.suspend(() => {
      const stopped = callsStopped;
      callsStopped = Deferred.makeUnsafe();
      return Deferred.succeed(stopped, undefined);
    }).pipe(Effect.asVoid),
    dispose: Effect.suspend(() =>
      Effect.forEach(
        [...connections.keys()],
        (connectionId) => disconnect({ connectionId }).pipe(Effect.ignore),
        { concurrency: "unbounded", discard: true },
      ),
    ),
  };
});
