import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/http/HttpBody";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import type { HttpEffect } from "../../Http.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { DurableObjectState } from "./DurableObjectState.ts";
import { fromWebSocket, type WebSocket } from "./WebSocket.ts";

const socketTag = "alchemy:rpc";
const attachmentKey = "__alchemyRpcWebSocket";
const restartReason = "Durable Object RPC activation reset";
const Metadata = Schema.Struct({
  version: Schema.Literal(1),
  clientId: Schema.Number,
  pending: Schema.Boolean,
  serialization: Schema.String,
});
const isAttachment = Schema.is(Schema.Struct({ [attachmentKey]: Metadata }));

interface Connection {
  readonly id: number;
  readonly socket: WebSocket;
  readonly parser: RpcSerialization.Parser;
  readonly pending: Set<string | number>;
  readonly idle: Latch.Latch;
}

export interface Transport {
  readonly protocol: RpcServer.Protocol["Service"];
  readonly fetch: HttpEffect;
  readonly webSocketMessage: (
    socket: WebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void>;
  readonly webSocketClose: (socket: WebSocket) => Effect.Effect<void>;
  readonly webSocketError: (
    socket: WebSocket,
    error: unknown,
  ) => Effect.Effect<void>;
}

/**
 * Internal, per-activation transport. Provide `protocol` to `RpcServer.layer`
 * in an instance-owned scope, not the first fetch or WebSocket event's scope.
 * This transport exclusively owns the object's WebSocket auto-response pair.
 * Binary serializers use waking Ping/Pong messages instead of auto-response.
 * Serializers must emit each response immediately; buffered output fails closed.
 */
export const make: Effect.Effect<
  Transport,
  never,
  DurableObjectState | RuntimeContext | RpcSerialization.RpcSerialization
> = Effect.gen(function* () {
  const state = yield* DurableObjectState;
  const runtime = yield* RuntimeContext;
  const serialization = yield* RpcSerialization.RpcSerialization;
  const native = globalThis as unknown as {
    WebSocketPair: typeof cf.WebSocketPair;
    WebSocketRequestResponsePair: typeof cf.WebSocketRequestResponsePair;
    Response: typeof cf.Response;
  };
  const inRuntime = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
    Effect.provideService(effect, RuntimeContext, runtime);
  const disconnects = yield* Queue.make<number>();
  const ready = yield* Latch.make();
  const bySocket = new Map<cf.WebSocket, Connection>();
  const byId = new Map<number, Connection>();
  const closed = new WeakSet<cf.WebSocket>();
  let nextId = 0;
  let restoring = true;
  let stopped = false;
  let receive: Parameters<RpcServer.Protocol["Service"]["run"]>[0] | undefined;

  const heartbeat = yield* Effect.sync(() => {
    const parser = serialization.makeUnsafe();
    const ping = parser.encode(RpcMessage.constPing);
    const pong = parser.encode(RpcMessage.constPong);
    return typeof ping === "string" && typeof pong === "string"
      ? new native.WebSocketRequestResponsePair(ping, pong)
      : undefined;
  });
  const existing = yield* inRuntime(state.getWebSocketAutoResponse());
  if (
    existing !== null &&
    (heartbeat === undefined ||
      existing.request !== heartbeat.request ||
      existing.response !== heartbeat.response)
  ) {
    return yield* Effect.die(
      new Error("RPC WebSockets require exclusive ownership of auto-response"),
    );
  }
  let heartbeatEnabled = existing !== null;

  const syncHeartbeat = Effect.suspend(() => {
    const enabled =
      !restoring &&
      !stopped &&
      heartbeat !== undefined &&
      byId.size > 0 &&
      !Array.from(byId.values()).some(
        (connection) => connection.pending.size > 0,
      );
    if (enabled === heartbeatEnabled) return Effect.void;
    return inRuntime(
      state.setWebSocketAutoResponse(enabled ? heartbeat : undefined),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          heartbeatEnabled = enabled;
        }),
      ),
      Effect.catchCause(() =>
        inRuntime(state.abort("Unable to update RPC WebSocket heartbeat")),
      ),
    );
  });
  yield* syncHeartbeat;

  const persist = (connection: Connection) =>
    Effect.sync(() => {
      const previous = connection.socket.deserializeAttachment<unknown>();
      if (
        previous !== null &&
        previous !== undefined &&
        (typeof previous !== "object" || Array.isArray(previous))
      ) {
        throw new Error("Invalid RPC WebSocket attachment");
      }
      connection.socket.serializeAttachment({
        ...previous,
        [attachmentKey]: {
          version: 1,
          clientId: connection.id,
          pending: connection.pending.size > 0,
          serialization: serialization.contentType,
        } satisfies typeof Metadata.Type,
      });
    });

  const unregister = (socket: WebSocket) =>
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        closed.add(socket.ws);
        const connection = bySocket.get(socket.ws);
        if (connection === undefined) return;
        bySocket.delete(socket.ws);
        byId.delete(connection.id);
        connection.pending.clear();
        connection.idle.openUnsafe();
        Queue.offerUnsafe(disconnects, connection.id);
      });
      yield* syncHeartbeat;
    });

  const close = (socket: WebSocket, code = 1012, reason = restartReason) =>
    socket.close(code, reason).pipe(
      Effect.catchCause(() =>
        inRuntime(state.abort("Unable to close RPC WebSocket")),
      ),
      Effect.ensuring(unregister(socket)),
      Effect.uninterruptible,
    );

  const register = (socket: WebSocket, id: number): Connection => {
    const connection: Connection = {
      id,
      socket,
      parser: serialization.makeUnsafe(),
      pending: new Set(),
      idle: Latch.makeUnsafe(true),
    };
    bySocket.set(socket.ws, connection);
    byId.set(id, connection);
    nextId = Math.max(nextId, id + 1);
    return connection;
  };

  for (const socket of yield* inRuntime(state.getWebSockets(socketTag))) {
    yield* Effect.gen(function* () {
      const attachment = yield* Effect.sync(() =>
        socket.deserializeAttachment<unknown>(),
      );
      if (!isAttachment(attachment)) return yield* close(socket);
      const metadata = attachment[attachmentKey];
      if (
        metadata.pending ||
        metadata.serialization !== serialization.contentType ||
        !Number.isSafeInteger(metadata.clientId) ||
        metadata.clientId < 0 ||
        byId.has(metadata.clientId)
      ) {
        return yield* close(socket);
      }
      const connection = yield* Effect.sync(() =>
        register(socket, metadata.clientId),
      );
      yield* persist(connection);
    }).pipe(Effect.catchCause(() => close(socket)));
  }
  restoring = false;
  yield* syncHeartbeat;

  const send = (
    connection: Connection,
    response: RpcMessage.FromServerEncoded,
  ) =>
    Effect.gen(function* () {
      if (!byId.has(connection.id)) return;
      const encoded = yield* Effect.sync(() =>
        connection.parser.encode(response),
      );
      // Buffered responses cannot be recovered after hibernation.
      if (encoded === undefined) return yield* close(connection.socket);
      yield* connection.socket.send(encoded);
      if (response._tag === "Exit") {
        connection.pending.delete(response.requestId);
        yield* persist(connection);
        if (connection.pending.size === 0) yield* connection.idle.open;
        yield* syncHeartbeat;
      }
      if (
        response._tag === "Defect" ||
        response._tag === "ClientProtocolError"
      ) {
        yield* close(connection.socket);
      }
    }).pipe(
      Effect.catchCause(() => close(connection.socket)),
      Effect.uninterruptible,
    );

  const protocol = RpcServer.Protocol.of({
    run: (write) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          if (receive !== undefined || stopped) {
            throw new Error(
              "RPC WebSocket protocol is already running or stopped",
            );
          }
          receive = write;
        }),
        () => ready.open.pipe(Effect.andThen(Effect.never)),
        () =>
          Effect.gen(function* () {
            stopped = true;
            receive = undefined;
            yield* ready.open;
            for (const connection of Array.from(byId.values())) {
              yield* close(connection.socket);
            }
            yield* syncHeartbeat;
          }),
      ),
    disconnects,
    send: (id, response) =>
      Effect.suspend(() => {
        const connection = byId.get(id);
        return connection === undefined
          ? Effect.void
          : send(connection, response);
      }),
    end: (id) =>
      Effect.suspend(() => {
        const connection = byId.get(id);
        return connection === undefined
          ? Effect.void
          : close(connection.socket, 1000, "");
      }),
    clientIds: Effect.sync(() => new Set(byId.keys())),
    initialMessage: Effect.succeedNone,
    supportsAck: true,
    supportsTransferables: false,
    supportsSpanPropagation: true,
    supportsNotifications: true,
    codecFor: serialization.codecFor,
  });

  const fetch: HttpEffect = Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    if (
      request.method !== "GET" ||
      request.headers.upgrade?.toLowerCase() !== "websocket"
    ) {
      return HttpServerResponse.empty({
        status: 426,
        headers: { Upgrade: "websocket" },
      });
    }
    yield* ready.await;
    if (stopped) return HttpServerResponse.empty({ status: 503 });
    const pair = yield* Effect.sync(() => new native.WebSocketPair());
    const socket = fromWebSocket(pair[1]);
    let accepted = false;
    return yield* Effect.gen(function* () {
      yield* inRuntime(state.acceptWebSocket(socket, [socketTag]));
      accepted = true;
      const connection = yield* Effect.sync(() => register(socket, nextId));
      yield* persist(connection);
      yield* syncHeartbeat;
      return yield* Effect.sync(() =>
        HttpServerResponse.setBody(
          HttpServerResponse.empty({ status: 101 }),
          HttpBody.raw(
            new native.Response(null, { status: 101, webSocket: pair[0] }),
          ),
        ),
      );
    }).pipe(
      Effect.catchCause(() =>
        (accepted ? close(socket) : Effect.void).pipe(
          Effect.as(HttpServerResponse.empty({ status: 503 })),
        ),
      ),
      Effect.uninterruptible,
    );
  });

  const webSocketMessage = (socket: WebSocket, message: string | ArrayBuffer) =>
    Effect.gen(function* () {
      if (closed.has(socket.ws)) return;
      yield* ready.await;
      const connection = bySocket.get(socket.ws);
      if (connection === undefined || receive === undefined)
        return yield* close(socket);
      const messages = yield* Effect.sync(() =>
        connection.parser.decode(
          typeof message === "string" ? message : new Uint8Array(message),
        ),
      );
      // The serializer owns the envelopes; RpcServer validates payloads and schemas.
      const requests = messages as ReadonlyArray<RpcMessage.FromClientEncoded>;
      let hasRequests = false;
      for (const request of requests) {
        if (request._tag !== "Request") continue;
        if (
          (typeof request.id !== "string" &&
            !(typeof request.id === "number" && Number.isFinite(request.id))) ||
          connection.pending.has(request.id)
        ) {
          return yield* close(socket);
        }
        connection.pending.add(request.id);
        hasRequests = true;
      }
      if (hasRequests) {
        yield* connection.idle.close;
        // Mark the entire batch before dispatching even its first request.
        yield* persist(connection);
        yield* syncHeartbeat;
        yield* inRuntime(state.waitUntil(connection.idle.await));
      }
      for (const request of requests) {
        if (!byId.has(connection.id)) return;
        // Direct dispatch preserves this event's context; RpcServer creates each RPC scope.
        yield* receive(connection.id, request);
      }
    }).pipe(Effect.catchCause(() => close(socket)));

  return {
    protocol,
    fetch,
    webSocketMessage,
    webSocketClose: (socket) => close(socket, 1000, ""),
    webSocketError: (socket) => close(socket),
  } satisfies Transport;
});
