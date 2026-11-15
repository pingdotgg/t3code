// @effect-diagnostics globalJsonInEffect:off
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as AcpSchema from "effect-acp/compat";

import { discardResponseBody, responsePayloads } from "@t3tools/shared/mcpResponsePayloads";

const T3_SERVER_ID = "t3-code";
const MAX_CONNECTIONS = 16;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

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
  nextRequestId: number;
  retired: boolean;
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

function errorOutcome(error: unknown): AcpSchema.McpServerMessageResponse {
  const { code, data } = (asEnvelope(error) ?? {}) as {
    readonly code?: unknown;
    readonly data?: unknown;
  };
  return {
    error: {
      code: typeof code === "number" ? code : -32603,
      message: errorMessage(error),
      ...(data === undefined ? {} : { data: data as Schema.Json }),
    },
  };
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
  readonly dispose: Effect.Effect<void>;
}

export const makeAcpMcpOverAcpBridge = Effect.fn("AcpMcpOverAcpBridge.make")(function* (
  options: AcpMcpOverAcpBridgeOptions,
): Effect.fn.Return<AcpMcpOverAcpBridge> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const connections = yield* Effect.sync(() => new Map<string, Connection>());
  const makeConnection = Effect.map(Semaphore.make(1), (mutex): Connection => ({
    mutex,
    sessionId: null,
    protocolVersion: null,
    nextRequestId: 0,
    retired: false,
  }));
  // Current-draft agents address the declared server directly; each initialize opens a new MCP session.
  let serverConnection = yield* makeConnection;

  const checkServerId = (serverId: string): Effect.Effect<void, AcpMcpOverAcpError> =>
    serverId === T3_SERVER_ID
      ? Effect.void
      : Effect.fail(new AcpMcpOverAcpError({ message: `Unknown ACP MCP server "${serverId}".` }));

  const legacyConnection = (connectionId: string): Effect.Effect<Connection, AcpMcpOverAcpError> =>
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

  const connectionFor = (
    request: AcpSchema.MessageMcpRequest | AcpSchema.MessageMcpNotification,
  ): Effect.Effect<Connection, AcpMcpOverAcpError> =>
    "connectionId" in request
      ? legacyConnection(request.connectionId)
      : checkServerId(request.serverId).pipe(
          Effect.andThen(
            request.method === "initialize"
              ? renewServerConnection
              : Effect.sync(() => serverConnection),
          ),
        );

  const renewServerConnection = Effect.gen(function* () {
    const previous = serverConnection;
    previous.retired = true;
    const connection = yield* makeConnection;
    serverConnection = connection;
    yield* close(previous).pipe(Effect.ignore);
    return connection;
  });

  // Only initialization needs ordering; negotiated calls may wait independently.
  const untilNegotiated = <A, E>(connection: Connection, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() =>
      connection.protocolVersion === null ? connection.mutex.withPermits(1)(effect) : effect,
    );

  // A rejected request still answers with its JSON-RPC error, e.g. the supported protocol versions.
  const rejectionPayloads = Effect.fn("mcpOverAcpBridge.rejectionPayloads")(function* (
    response: Response,
    id: number | undefined,
  ) {
    const payloads =
      id === undefined
        ? []
        : yield* Stream.runCollect(responsePayloads(response, bridgeError)).pipe(
            Effect.orElseSucceed(() => []),
          );
    yield* discardResponseBody(response);
    const answered = payloads.some((payload) => {
      const envelope = asEnvelope(payload);
      return envelope !== null && envelope.id === id && envelope.error !== undefined;
    });
    if (!answered) {
      return yield* new AcpMcpOverAcpError({
        message: `T3 Code MCP endpoint responded with HTTP ${response.status}.`,
      });
    }
    return [...payloads];
  });

  const send = (
    connection: Connection,
    request: AcpSchema.MessageMcpRequest | AcpSchema.MessageMcpNotification,
    id?: number,
  ): Effect.Effect<ReadonlyArray<unknown>, AcpMcpOverAcpError> =>
    untilNegotiated(
      connection,
      Effect.gen(function* () {
        const body = JSON.stringify({
          jsonrpc: "2.0",
          ...(id === undefined ? {} : { id }),
          method: request.method,
          ...(request.params == null ? {} : { params: request.params }),
        });
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
                authorization: options.authorization,
                ...(connection.sessionId === null
                  ? {}
                  : { "mcp-session-id": connection.sessionId }),
                ...(connection.protocolVersion === null
                  ? {}
                  : { "mcp-protocol-version": connection.protocolVersion }),
              },
              body,
            }),
          catch: bridgeError,
        });
        connection.sessionId = response.headers.get("mcp-session-id") ?? connection.sessionId;
        const payloads = response.ok
          ? [...(yield* Stream.runCollect(responsePayloads(response, bridgeError)))]
          : yield* rejectionPayloads(response, id);
        for (const payload of payloads) {
          connection.protocolVersion = protocolVersionOf(payload) ?? connection.protocolVersion;
        }
        return payloads;
      }).pipe(
        Effect.mapError(bridgeError),
        // An initialize replaced while in flight must not leave its session behind, even on failure.
        Effect.ensuring(
          Effect.suspend(() =>
            connection.retired ? close(connection).pipe(Effect.ignore) : Effect.void,
          ),
        ),
      ),
    );

  const close = Effect.fn("mcpOverAcpBridge.close")(function* (connection: Connection) {
    const sessionId = connection.sessionId;
    if (sessionId === null) return;
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetchImplementation(options.endpoint, {
          method: "DELETE",
          signal,
          headers: {
            authorization: options.authorization,
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
    connection.sessionId = null;
    yield* discardResponseBody(response);
  });

  const disconnect = Effect.fn("mcpOverAcpBridge.disconnect")(function* (
    request: AcpSchema.DisconnectMcpRequest,
  ): Effect.fn.Return<AcpSchema.DisconnectMcpResponse, AcpMcpOverAcpError> {
    const connection = yield* legacyConnection(request.connectionId);
    connections.delete(request.connectionId);
    yield* close(connection);
    return {};
  });

  return {
    connect: Effect.fn("mcpOverAcpBridge.connect")(function* (request) {
      yield* checkServerId(request.serverId);
      if (connections.size >= MAX_CONNECTIONS) {
        return yield* new AcpMcpOverAcpError({ message: "Too many MCP-over-ACP connections." });
      }
      const connectionId = yield* options.allocateConnectionId;
      connections.set(connectionId, yield* makeConnection);
      return { connectionId };
    }),
    message: Effect.fn("mcpOverAcpBridge.message")(function* (request) {
      const connection = yield* connectionFor(request);
      const id = ++connection.nextRequestId;
      const payloads = yield* send(connection, request, id);
      const response = payloads.find((payload) => asEnvelope(payload)?.id === id);
      const envelope = asEnvelope(response);
      if (envelope === null) {
        return yield* new AcpMcpOverAcpError({
          message: "MCP server did not return a matching response.",
        });
      }
      const result = (envelope.result ?? null) as Schema.Json;
      // Legacy drafts answer with the bare inner result and surface inner errors as ACP errors.
      if ("connectionId" in request) {
        if (envelope.error !== undefined) {
          return yield* new AcpMcpOverAcpError({ message: errorMessage(envelope.error) });
        }
        return result;
      }
      return envelope.error === undefined ? { result } : errorOutcome(envelope.error);
    }),
    notification: Effect.fn("mcpOverAcpBridge.notification")(function* (request) {
      const connection = yield* connectionFor(request);
      yield* send(connection, request);
    }),
    disconnect,
    dispose: Effect.suspend(() =>
      Effect.forEach(
        [...connections.keys()],
        (connectionId) => disconnect({ connectionId }).pipe(Effect.ignore),
        { discard: true },
      ),
    ).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          serverConnection.retired = true;
          return close(serverConnection);
        }).pipe(Effect.ignore),
      ),
    ),
  };
});
