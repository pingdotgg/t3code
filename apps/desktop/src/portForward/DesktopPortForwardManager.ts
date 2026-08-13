import {
  DesktopPortForwardId,
  type DesktopPortForwardAuthorizationRequest,
  type DesktopPortForwardCreateInput,
  type DesktopPortForwardSnapshot,
  TCP_PORT_FORWARD_FRAME_ACK,
  TCP_PORT_FORWARD_FRAME_CLOSE,
  TCP_PORT_FORWARD_FRAME_DATA,
  TCP_PORT_FORWARD_FRAME_ERROR,
  TCP_PORT_FORWARD_FRAME_WRITE_END,
  TCP_PORT_FORWARD_INITIAL_CREDIT,
  TCP_PORT_FORWARD_MAX_DATA_SIZE,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as NodeNet from "node:net";

const AUTHORIZATION_TIMEOUT = Duration.seconds(15);
const MAX_CONNECTIONS_PER_FORWARD = 32;
const MAX_CONNECTIONS_TOTAL = 128;
const IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
const NEARBY_PORT_SEARCH_DISTANCE = 20;

type StateListener = (snapshots: ReadonlyArray<DesktopPortForwardSnapshot>) => Effect.Effect<void>;
type AuthorizationListener = (
  request: DesktopPortForwardAuthorizationRequest,
) => Effect.Effect<void>;

interface ManagedForward {
  snapshot: DesktopPortForwardSnapshot;
  readonly server: NodeNet.Server;
  readonly sockets: Set<NodeNet.Socket>;
  readonly webSockets: Set<WebSocket>;
}

export class DesktopPortForwardError extends Schema.TaggedErrorClass<DesktopPortForwardError>()(
  "DesktopPortForwardError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Desktop port forward ${this.operation} failed.`;
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

const listen = (server: NodeNet.Server, port: number) =>
  Effect.callback<number, DesktopPortForwardError>((resume) => {
    const onError = (cause: Error) => {
      server.off("listening", onListening);
      resume(Effect.fail(new DesktopPortForwardError({ operation: "listen", cause })));
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        resume(
          Effect.fail(
            new DesktopPortForwardError({
              operation: "resolve-listener-address",
              cause: address,
            }),
          ),
        );
        return;
      }
      resume(Effect.succeed(address.port));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
    return Effect.sync(() => {
      server.off("error", onError);
      server.off("listening", onListening);
      server.close();
    });
  });

const automaticLocalPortCandidates = (preferredPort: number): ReadonlyArray<number> => {
  const candidates = [preferredPort];
  for (let distance = 1; distance <= NEARBY_PORT_SEARCH_DISTANCE; distance += 1) {
    const higher = preferredPort + distance;
    const lower = preferredPort - distance;
    if (higher <= 65_535) candidates.push(higher);
    if (lower >= 1) candidates.push(lower);
  }
  return candidates;
};

const listenAutomatically = Effect.fn("DesktopPortForwardManager.listenAutomatically")(function* (
  server: NodeNet.Server,
  preferredPort: number,
) {
  for (const candidate of automaticLocalPortCandidates(preferredPort)) {
    const attempt = yield* Effect.result(listen(server, candidate));
    if (Result.isSuccess(attempt)) return attempt.success;

    const cause = attempt.failure.cause;
    const code =
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : null;
    if (code === "EACCES") break;
    if (code !== "EADDRINUSE") return yield* attempt.failure;
  }
  return yield* listen(server, 0);
});

const openWebSocket = (socketUrl: string) =>
  Effect.callback<WebSocket, DesktopPortForwardError>((resume) => {
    let url: URL;
    try {
      url = new URL(socketUrl);
    } catch (cause) {
      resume(Effect.fail(new DesktopPortForwardError({ operation: "validate-ticket-url", cause })));
      return;
    }
    if (
      (url.protocol !== "ws:" && url.protocol !== "wss:") ||
      url.pathname !== "/ws/tcp-forward" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      resume(
        Effect.fail(
          new DesktopPortForwardError({
            operation: "validate-ticket-url",
            cause: "The renderer supplied an invalid bridge URL.",
          }),
        ),
      );
      return;
    }
    const webSocket = new WebSocket(url);
    webSocket.binaryType = "arraybuffer";
    const onOpen = () => {
      webSocket.removeEventListener("error", onError);
      resume(Effect.succeed(webSocket));
    };
    const onError = (cause: Event) => {
      webSocket.removeEventListener("open", onOpen);
      webSocket.close();
      resume(Effect.fail(new DesktopPortForwardError({ operation: "connect-bridge", cause })));
    };
    webSocket.addEventListener("open", onOpen, { once: true });
    webSocket.addEventListener("error", onError, { once: true });
    return Effect.sync(() => {
      webSocket.removeEventListener("open", onOpen);
      webSocket.removeEventListener("error", onError);
      webSocket.close();
    });
  });

const runConnection = (socket: NodeNet.Socket, webSocket: WebSocket): Effect.Effect<void, never> =>
  Effect.callback<void>((resume) => {
    let credit = TCP_PORT_FORWARD_INITIAL_CREDIT;
    let outstanding = 0;
    let pending: Uint8Array = new Uint8Array(0);
    let socketEnded = false;
    let closed = false;

    const send = (frame: Uint8Array) => {
      if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.send(frame.slice().buffer as ArrayBuffer);
      }
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      socket.destroy();
      if (
        webSocket.readyState === WebSocket.OPEN ||
        webSocket.readyState === WebSocket.CONNECTING
      ) {
        webSocket.close();
      }
      resume(Effect.void);
    };
    const protocolFailure = () => {
      send(controlFrame(TCP_PORT_FORWARD_FRAME_ERROR));
      finish();
    };
    const flushSocketData = () => {
      while (credit > 0 && pending.byteLength > 0) {
        const size = Math.min(credit, TCP_PORT_FORWARD_MAX_DATA_SIZE, pending.byteLength);
        const chunk = pending.subarray(0, size);
        pending = pending.subarray(size);
        credit -= size;
        outstanding += size;
        send(dataFrame(chunk));
      }
      if (pending.byteLength === 0 && credit > 0) socket.resume();
      else socket.pause();
    };
    const onSocketData = (chunk: Buffer) => {
      if (pending.byteLength === 0) {
        pending = chunk;
      } else {
        const combined = new Uint8Array(pending.byteLength + chunk.byteLength);
        combined.set(pending);
        combined.set(chunk, pending.byteLength);
        pending = combined;
      }
      flushSocketData();
    };
    const onSocketEnd = () => send(controlFrame(TCP_PORT_FORWARD_FRAME_WRITE_END));
    const onSocketError = () => finish();
    const onSocketClose = () => {
      send(controlFrame(TCP_PORT_FORWARD_FRAME_CLOSE));
      finish();
    };
    const onWebSocketClose = () => finish();
    const onWebSocketError = () => finish();
    const onWebSocketMessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) {
        protocolFailure();
        return;
      }
      const frame = new Uint8Array(event.data);
      switch (frame[0]) {
        case TCP_PORT_FORWARD_FRAME_DATA: {
          const payload = frame.subarray(1);
          if (
            payload.byteLength === 0 ||
            payload.byteLength > TCP_PORT_FORWARD_MAX_DATA_SIZE ||
            socketEnded
          ) {
            protocolFailure();
            return;
          }
          socket.write(payload, (error) => {
            if (error) finish();
            else send(ackFrame(payload.byteLength));
          });
          return;
        }
        case TCP_PORT_FORWARD_FRAME_ACK: {
          if (frame.byteLength !== 5) {
            protocolFailure();
            return;
          }
          const bytes = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
            1,
            false,
          );
          if (bytes === 0 || bytes > outstanding) {
            protocolFailure();
            return;
          }
          outstanding -= bytes;
          credit += bytes;
          flushSocketData();
          return;
        }
        case TCP_PORT_FORWARD_FRAME_WRITE_END:
          if (frame.byteLength !== 1 || socketEnded) {
            protocolFailure();
            return;
          }
          socketEnded = true;
          socket.end();
          return;
        case TCP_PORT_FORWARD_FRAME_CLOSE:
          if (frame.byteLength !== 1) {
            protocolFailure();
            return;
          }
          finish();
          return;
        case TCP_PORT_FORWARD_FRAME_ERROR:
          if (frame.byteLength > 513) {
            protocolFailure();
            return;
          }
          finish();
          return;
        default:
          protocolFailure();
      }
    };

    socket.on("data", onSocketData);
    socket.once("end", onSocketEnd);
    socket.once("error", onSocketError);
    socket.once("close", onSocketClose);
    webSocket.addEventListener("message", onWebSocketMessage);
    webSocket.addEventListener("close", onWebSocketClose, { once: true });
    webSocket.addEventListener("error", onWebSocketError, { once: true });
    socket.setTimeout(IDLE_TIMEOUT_MS, finish);

    return Effect.sync(() => {
      socket.off("data", onSocketData);
      socket.off("end", onSocketEnd);
      socket.off("error", onSocketError);
      socket.off("close", onSocketClose);
      webSocket.removeEventListener("message", onWebSocketMessage);
      webSocket.removeEventListener("close", onWebSocketClose);
      webSocket.removeEventListener("error", onWebSocketError);
      socket.destroy();
      webSocket.close();
    });
  });

export class DesktopPortForwardManager extends Context.Service<
  DesktopPortForwardManager,
  {
    readonly create: (
      input: DesktopPortForwardCreateInput,
    ) => Effect.Effect<DesktopPortForwardSnapshot, DesktopPortForwardError>;
    readonly list: Effect.Effect<ReadonlyArray<DesktopPortForwardSnapshot>>;
    readonly stop: (id: DesktopPortForwardId) => Effect.Effect<void>;
    readonly stopEnvironment: (
      environmentId: DesktopPortForwardSnapshot["environmentId"],
    ) => Effect.Effect<void>;
    readonly resolveAuthorization: (
      requestId: string,
      socketUrl: string | null,
    ) => Effect.Effect<void>;
    readonly subscribeStateChanges: (
      listener: StateListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribeAuthorizationRequests: (
      listener: AuthorizationListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/portForward/DesktopPortForwardManager") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const forwards = yield* Ref.make(new Map<DesktopPortForwardId, ManagedForward>());
  const pendingAuthorizations = yield* Ref.make(
    new Map<string, Deferred.Deferred<string, DesktopPortForwardError>>(),
  );
  const stateListeners = yield* Ref.make(new Set<StateListener>());
  const authorizationListeners = yield* Ref.make(new Set<AuthorizationListener>());

  const snapshots = Ref.get(forwards).pipe(
    Effect.map((current) =>
      [...current.values()]
        .map((forward) => forward.snapshot)
        .toSorted((a, b) => a.localPort - b.localPort),
    ),
  );
  const publishState = Effect.flatMap(snapshots, (next) =>
    Ref.get(stateListeners).pipe(
      Effect.flatMap((listeners) => Effect.forEach(listeners, (listener) => listener(next))),
      Effect.asVoid,
    ),
  );
  const updateSnapshot = (
    id: DesktopPortForwardId,
    update: (snapshot: DesktopPortForwardSnapshot) => DesktopPortForwardSnapshot,
  ) =>
    Ref.update(forwards, (current) => {
      const forward = current.get(id);
      if (forward === undefined) return current;
      forward.snapshot = update(forward.snapshot);
      return new Map(current);
    }).pipe(Effect.andThen(publishState));

  const authorize = Effect.fn("DesktopPortForwardManager.authorize")(function* (
    forward: ManagedForward,
  ) {
    const requestId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => new DesktopPortForwardError({ operation: "authorize", cause })),
    );
    const deferred = yield* Deferred.make<string, DesktopPortForwardError>();
    yield* Ref.update(pendingAuthorizations, (current) =>
      new Map(current).set(requestId, deferred),
    );
    const listeners = yield* Ref.get(authorizationListeners);
    const request: DesktopPortForwardAuthorizationRequest = {
      requestId,
      forwardId: forward.snapshot.id,
      environmentId: forward.snapshot.environmentId,
      remoteHost: forward.snapshot.remoteHost,
      remotePort: forward.snapshot.remotePort,
    };
    yield* Effect.forEach(listeners, (listener) => listener(request), { discard: true });
    return yield* Deferred.await(deferred).pipe(
      Effect.timeoutOption(AUTHORIZATION_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new DesktopPortForwardError({
                operation: "authorize",
                cause: "Timed out waiting for renderer authorization.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.ensuring(
        Ref.update(pendingAuthorizations, (current) => {
          const next = new Map(current);
          next.delete(requestId);
          return next;
        }),
      ),
    );
  });

  const handleConnection = (forward: ManagedForward, socket: NodeNet.Socket) =>
    Effect.gen(function* () {
      const accepted = yield* Ref.modify(forwards, (current) => {
        const activeTotal = [...current.values()].reduce(
          (total, entry) => total + entry.sockets.size,
          0,
        );
        if (
          !current.has(forward.snapshot.id) ||
          forward.sockets.size >= MAX_CONNECTIONS_PER_FORWARD ||
          activeTotal >= MAX_CONNECTIONS_TOTAL
        ) {
          return [false, current] as const;
        }
        forward.sockets.add(socket);
        return [true, new Map(current)] as const;
      });
      if (!accepted) {
        socket.destroy();
        return;
      }
      yield* updateSnapshot(forward.snapshot.id, (snapshot) => ({
        ...snapshot,
        activeConnections: snapshot.activeConnections + 1,
        lastError: null,
      }));
      const socketUrl = yield* authorize(forward);
      const webSocket = yield* openWebSocket(socketUrl);
      forward.webSockets.add(webSocket);
      yield* runConnection(socket, webSocket);
      forward.webSockets.delete(webSocket);
    }).pipe(
      Effect.catch((error) =>
        updateSnapshot(forward.snapshot.id, (snapshot) => ({
          ...snapshot,
          lastError: error.message,
        })),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          forward.sockets.delete(socket);
          socket.destroy();
          yield* updateSnapshot(forward.snapshot.id, (snapshot) => ({
            ...snapshot,
            activeConnections: Math.max(0, snapshot.activeConnections - 1),
          }));
        }),
      ),
    );

  const create: DesktopPortForwardManager["Service"]["create"] = Effect.fn(
    "DesktopPortForwardManager.create",
  )(function* (input) {
    const id = DesktopPortForwardId.make(
      yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new DesktopPortForwardError({ operation: "create", cause })),
      ),
    );
    let managed: ManagedForward | undefined;
    const server = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
      if (managed !== undefined) runFork(handleConnection(managed, socket));
      else socket.destroy();
    });
    const localPort =
      input.localPort === undefined
        ? yield* listenAutomatically(server, input.remotePort)
        : yield* listen(server, input.localPort);
    const snapshot: DesktopPortForwardSnapshot = {
      id,
      environmentId: input.environmentId,
      localHost: "127.0.0.1",
      localPort,
      remoteHost: input.remoteHost,
      remotePort: input.remotePort,
      status: "running",
      activeConnections: 0,
      lastError: null,
    };
    managed = { snapshot, server, sockets: new Set(), webSockets: new Set() };
    yield* Ref.update(forwards, (current) => new Map(current).set(id, managed!));
    yield* publishState;
    return snapshot;
  });

  const stopManaged = (managed: ManagedForward) =>
    Effect.sync(() => {
      managed.server.close();
      for (const socket of managed.sockets) socket.destroy();
      for (const webSocket of managed.webSockets) webSocket.close();
    });

  const stop: DesktopPortForwardManager["Service"]["stop"] = (id) =>
    Ref.modify(forwards, (current) => {
      const next = new Map(current);
      const managed = next.get(id);
      next.delete(id);
      return [Option.fromUndefinedOr(managed), next] as const;
    }).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: stopManaged })),
      Effect.andThen(publishState),
    );

  const stopEnvironment: DesktopPortForwardManager["Service"]["stopEnvironment"] = (
    environmentId,
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(forwards);
      yield* Effect.forEach(
        current.values(),
        (managed) =>
          managed.snapshot.environmentId === environmentId
            ? stop(managed.snapshot.id)
            : Effect.void,
        { discard: true },
      );
    });

  const resolveAuthorization: DesktopPortForwardManager["Service"]["resolveAuthorization"] = (
    requestId,
    socketUrl,
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(pendingAuthorizations);
      const deferred = current.get(requestId);
      if (deferred === undefined) return;
      if (socketUrl === null) {
        yield* Deferred.fail(
          deferred,
          new DesktopPortForwardError({
            operation: "authorize",
            cause: "The environment could not authorize this connection.",
          }),
        );
      } else {
        yield* Deferred.succeed(deferred, socketUrl);
      }
    });

  const subscribe = <A>(
    ref: Ref.Ref<Set<(value: A) => Effect.Effect<void>>>,
    listener: (value: A) => Effect.Effect<void>,
  ) =>
    Effect.acquireRelease(
      Ref.update(ref, (current) => new Set(current).add(listener)),
      () =>
        Ref.update(ref, (current) => {
          const next = new Set(current);
          next.delete(listener);
          return next;
        }),
    );

  yield* Effect.addFinalizer(() =>
    Ref.get(forwards).pipe(
      Effect.flatMap((current) => Effect.forEach(current.values(), stopManaged, { discard: true })),
    ),
  );

  return DesktopPortForwardManager.of({
    create,
    list: snapshots,
    stop,
    stopEnvironment,
    resolveAuthorization,
    subscribeStateChanges: (listener) => subscribe(stateListeners, listener),
    subscribeAuthorizationRequests: (listener) => subscribe(authorizationListeners, listener),
  });
});

export const layer = Layer.effect(DesktopPortForwardManager, make);
