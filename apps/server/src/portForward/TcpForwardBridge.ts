import {
  AuthTerminalOperateScope,
  TCP_PORT_FORWARD_FRAME_ACK,
  TCP_PORT_FORWARD_FRAME_CLOSE,
  TCP_PORT_FORWARD_FRAME_DATA,
  TCP_PORT_FORWARD_FRAME_ERROR,
  TCP_PORT_FORWARD_FRAME_WRITE_END,
  TCP_PORT_FORWARD_INITIAL_CREDIT,
  TCP_PORT_FORWARD_MAX_DATA_SIZE,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodeNet from "node:net";

import { failEnvironmentAuthInvalid } from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as TcpForwardTicketStore from "./TcpForwardTicketStore.ts";

const MAX_CONCURRENT_FORWARD_CONNECTIONS = 128;
const IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

export class TcpForwardTargetConnectError extends Schema.TaggedErrorClass<TcpForwardTargetConnectError>()(
  "TcpForwardTargetConnectError",
  { host: Schema.String, port: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not connect to TCP forward target ${this.host}:${this.port}.`;
  }
}

const controlFrame = (kind: number) => Uint8Array.of(kind);

const dataFrame = (data: Uint8Array) => {
  const frame = new Uint8Array(data.byteLength + 1);
  frame[0] = TCP_PORT_FORWARD_FRAME_DATA;
  frame.set(data, 1);
  return frame;
};

const ackFrame = (bytes: number) => {
  const frame = new Uint8Array(5);
  frame[0] = TCP_PORT_FORWARD_FRAME_ACK;
  new DataView(frame.buffer).setUint32(1, bytes, false);
  return frame;
};

const errorFrame = (message: string) => {
  const encoded = new TextEncoder().encode(message).slice(0, 512);
  const frame = new Uint8Array(encoded.byteLength + 1);
  frame[0] = TCP_PORT_FORWARD_FRAME_ERROR;
  frame.set(encoded, 1);
  return frame;
};

type CreateTargetConnection = (options: {
  host: string;
  port: number;
  allowHalfOpen: true;
}) => NodeNet.Socket;

const connectTargetAddress = (
  createConnection: CreateTargetConnection,
  host: string,
  port: number,
) =>
  Effect.callback<NodeNet.Socket, TcpForwardTargetConnectError>((resume) => {
    const target = createConnection({ host, port, allowHalfOpen: true });
    const onConnect = () => {
      target.off("error", onError);
      resume(Effect.succeed(target));
    };
    const onError = (cause: Error) => {
      target.off("connect", onConnect);
      target.destroy();
      resume(Effect.fail(new TcpForwardTargetConnectError({ host, port, cause })));
    };
    target.once("connect", onConnect);
    target.once("error", onError);
    return Effect.sync(() => {
      target.off("connect", onConnect);
      target.off("error", onError);
      target.destroy();
    });
  });

export const makeConnectTarget = (createConnection: CreateTargetConnection) =>
  Effect.fn("TcpForwardBridge.connectTarget")(function* (host: string, port: number) {
    return yield* connectTargetAddress(createConnection, host, port).pipe(
      Effect.catchTags({
        TcpForwardTargetConnectError: (ipv4Error) => {
          if (host !== "127.0.0.1") return Effect.fail(ipv4Error);
          return connectTargetAddress(createConnection, "::1", port).pipe(
            Effect.mapError(
              (ipv6Error) =>
                new TcpForwardTargetConnectError({
                  host,
                  port,
                  cause: new AggregateError(
                    [ipv4Error.cause, ipv6Error.cause],
                    `Could not connect to loopback target on port ${port}`,
                  ),
                }),
            ),
          );
        },
      }),
    );
  });

const connectTarget = makeConnectTarget((options) => NodeNet.createConnection(options));

export const makeTargetResource = <E, R>(
  connect: (host: string, port: number) => Effect.Effect<NodeNet.Socket, E, R>,
) =>
  Effect.fn("TcpForwardBridge.acquireTarget")(function* (host: string, port: number) {
    return yield* Effect.acquireRelease(connect(host, port), (socket) =>
      Effect.sync(() => socket.destroy()),
    );
  });

const acquireTarget = makeTargetResource(connectTarget);

export const subscribeAndVerifySession = Effect.fn("TcpForwardBridge.subscribeAndVerifySession")(
  function* (
    sessions: Pick<
      SessionStore.SessionStore["Service"],
      "subscribeChanges" | "verifyWebSocketToken"
    >,
    session: SessionStore.VerifiedSession,
  ) {
    const changes = yield* sessions.subscribeChanges;
    const refreshedSession = yield* sessions.verifyWebSocketToken(session.token);
    return { changes, session: refreshedSession };
  },
);

export const runBridge = Effect.fn("TcpForwardBridge.run")(function* (
  webSocket: Socket.Socket,
  target: NodeNet.Socket,
) {
  const writer = yield* webSocket.writer;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const closed = yield* Deferred.make<void>();
  let credit = TCP_PORT_FORWARD_INITIAL_CREDIT;
  let outstanding = 0;
  let receiveCredit = TCP_PORT_FORWARD_INITIAL_CREDIT;
  let pending: Uint8Array = new Uint8Array(0);
  let targetReadEnded = false;
  let targetReadEndSent = false;
  let targetWriteEnded = false;
  let closedOnce = false;

  const writeWebSocket = (frame: Uint8Array | Socket.CloseEvent) => {
    runFork(writer(frame).pipe(Effect.catch(() => Effect.void)));
  };
  const close = () => {
    if (closedOnce) return;
    closedOnce = true;
    runFork(Deferred.succeed(closed, undefined));
  };
  const flushTargetData = () => {
    while (credit > 0 && pending.byteLength > 0) {
      const size = Math.min(credit, TCP_PORT_FORWARD_MAX_DATA_SIZE, pending.byteLength);
      const chunk = pending.subarray(0, size);
      pending = pending.subarray(size);
      credit -= size;
      outstanding += size;
      writeWebSocket(dataFrame(chunk));
    }
    if (pending.byteLength === 0) {
      if (targetReadEnded && !targetReadEndSent) {
        targetReadEndSent = true;
        writeWebSocket(controlFrame(TCP_PORT_FORWARD_FRAME_WRITE_END));
      }
      if (!targetReadEnded && credit > 0) {
        target.resume();
        return;
      }
    }
    target.pause();
  };
  const onData = (chunk: Buffer) => {
    if (pending.byteLength === 0) {
      pending = chunk;
    } else {
      const combined = new Uint8Array(pending.byteLength + chunk.byteLength);
      combined.set(pending);
      combined.set(chunk, pending.byteLength);
      pending = combined;
    }
    flushTargetData();
  };
  const onEnd = () => {
    targetReadEnded = true;
    flushTargetData();
  };
  const onError = (cause: Error) => {
    writeWebSocket(errorFrame(cause.message));
    target.destroy();
  };
  const onClose = () => {
    writeWebSocket(controlFrame(TCP_PORT_FORWARD_FRAME_CLOSE));
    writeWebSocket(new Socket.CloseEvent(1000));
    close();
  };

  target.on("data", onData);
  target.once("end", onEnd);
  target.once("error", onError);
  target.once("close", onClose);
  target.setTimeout(IDLE_TIMEOUT_MS, () => target.destroy());

  const protocolFailure = (reason: string) => {
    writeWebSocket(errorFrame(reason));
    writeWebSocket(new Socket.CloseEvent(1002, "invalid tcp forward frame"));
    target.destroy();
  };

  const readWebSocket = webSocket.run((frame) => {
    const kind = frame[0];
    switch (kind) {
      case TCP_PORT_FORWARD_FRAME_DATA: {
        const payload = frame.subarray(1);
        if (payload.byteLength === 0 || payload.byteLength > TCP_PORT_FORWARD_MAX_DATA_SIZE) {
          protocolFailure("invalid data frame");
          return;
        }
        if (targetWriteEnded || target.destroyed) {
          protocolFailure("data received after write end");
          return;
        }
        if (payload.byteLength > receiveCredit) {
          protocolFailure("data exceeds receive credit");
          return;
        }
        receiveCredit -= payload.byteLength;
        target.write(payload, (error) => {
          if (error) onError(error);
          else {
            receiveCredit += payload.byteLength;
            writeWebSocket(ackFrame(payload.byteLength));
          }
        });
        return;
      }
      case TCP_PORT_FORWARD_FRAME_ACK: {
        if (frame.byteLength !== 5) {
          protocolFailure("invalid acknowledgement frame");
          return;
        }
        const bytes = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
          1,
          false,
        );
        if (bytes === 0 || bytes > outstanding) {
          protocolFailure("invalid acknowledgement credit");
          return;
        }
        outstanding -= bytes;
        credit += bytes;
        flushTargetData();
        return;
      }
      case TCP_PORT_FORWARD_FRAME_WRITE_END:
        if (frame.byteLength !== 1 || targetWriteEnded) {
          protocolFailure("invalid write-end frame");
          return;
        }
        targetWriteEnded = true;
        target.end();
        return;
      case TCP_PORT_FORWARD_FRAME_CLOSE:
        if (frame.byteLength !== 1) {
          protocolFailure("invalid close frame");
          return;
        }
        target.destroy();
        return;
      case TCP_PORT_FORWARD_FRAME_ERROR:
        if (frame.byteLength > 513) {
          protocolFailure("invalid error frame");
          return;
        }
        target.destroy();
        return;
      default:
        protocolFailure("unknown frame type");
    }
  });

  yield* Effect.raceFirst(readWebSocket, Deferred.await(closed)).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        target.off("data", onData);
        target.off("end", onEnd);
        target.off("error", onError);
        target.off("close", onClose);
        target.destroy();
      }),
    ),
  );
});

export const tcpPortForwardWebSocketRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const tickets = yield* TcpForwardTicketStore.TcpForwardTicketStore;
    const sessions = yield* SessionStore.SessionStore;
    const capacity = yield* Semaphore.make(MAX_CONCURRENT_FORWARD_CONNECTIONS);
    return HttpRouter.add(
      "GET",
      "/ws/tcp-forward",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        const ticket = Option.isSome(url) ? url.value.searchParams.get("ticket") : null;
        if (ticket === null || ticket.trim() === "") {
          return yield* failEnvironmentAuthInvalid("missing_credential");
        }
        const authorization = yield* tickets.consume(ticket).pipe(
          Effect.catchTags({
            TcpForwardTicketInvalidError: () => failEnvironmentAuthInvalid("invalid_credential"),
          }),
        );
        return yield* capacity.withPermit(
          Effect.scoped(
            Effect.gen(function* () {
              const sessionWatcher = yield* subscribeAndVerifySession(
                sessions,
                authorization.session,
              ).pipe(Effect.catch(() => failEnvironmentAuthInvalid("invalid_credential")));
              const refreshedSession = sessionWatcher.session;
              if (!refreshedSession.scopes.includes(AuthTerminalOperateScope)) {
                return yield* failEnvironmentAuthInvalid("invalid_credential");
              }
              const target = yield* acquireTarget(
                authorization.remoteHost,
                authorization.remotePort,
              );
              const webSocket = yield* request.upgrade;
              const revoked = Stream.fromEffectRepeat(PubSub.take(sessionWatcher.changes)).pipe(
                Stream.filter(
                  (change) =>
                    change.type === "clientRemoved" &&
                    change.sessionId === refreshedSession.sessionId,
                ),
                Stream.runHead,
                Effect.asVoid,
              );
              const expiresAt = refreshedSession.expiresAt;
              const expired =
                expiresAt === undefined
                  ? Effect.never
                  : DateTime.now.pipe(
                      Effect.flatMap((now) =>
                        Effect.sleep(
                          Duration.millis(
                            Math.max(0, expiresAt.epochMilliseconds - now.epochMilliseconds),
                          ),
                        ),
                      ),
                    );
              yield* Effect.raceFirst(
                runBridge(webSocket, target),
                Effect.raceFirst(revoked, expired),
              );
              return HttpServerResponse.empty();
            }),
          ),
        );
      }).pipe(
        Effect.catchTags({
          TcpForwardTargetConnectError: () =>
            Effect.succeed(HttpServerResponse.text("TCP target unavailable", { status: 502 })),
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
