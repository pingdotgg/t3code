import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ServerConfig,
  type ServerConfig as ServerConfigType,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/unstable/socket/Socket";

import {
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as RpcSession from "./session.ts";

type SocketEventType = "open" | "message" | "close" | "error";
type SocketEvent = {
  readonly code?: number;
  readonly data?: unknown;
  readonly reason?: string;
  readonly type: SocketEventType;
};
type SocketListener = (event: SocketEvent) => void;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TestWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: SocketEventType, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEventType, listener: SocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === TestWebSocket.CLOSED) {
      return;
    }
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: string) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: SocketEventType, event: SocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws?wsTicket=test",
  httpAuthorization: null,
  target: TARGET,
};

const SERVER_CONFIG: ServerConfigType = {
  environment: {
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    platform: {
      os: "darwin",
      arch: "arm64",
    },
    serverVersion: "0.0.0-test",
    capabilities: {
      repositoryIdentity: true,
    },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/keybindings.json",
  keybindings: [],
  issues: [],
  scheduledTasks: [],
  providers: [],
  availableEditors: [],
  availableTerminals: [],
  observability: {
    logsDirectoryPath: "/tmp/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.String,
  payload: Schema.Unknown,
  tag: Schema.String,
});
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const decodeRpcRequest = Schema.decodeUnknownSync(RpcRequest);
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const encodeServerConfig = Schema.encodeSync(ServerConfig);

const makeFactory = Effect.fn("TestRpcSessionFactory.make")(function* () {
  const sockets: TestWebSocket[] = [];
  const constructorLayer = Layer.succeed(Socket.WebSocketConstructor, (url) => {
    const socket = new TestWebSocket(url);
    sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  });
  const layer = RpcSession.layer.pipe(Layer.provide(constructorLayer));
  const factory = yield* RpcSession.RpcSessionFactory.pipe(Effect.provide(layer));
  return { factory, sockets };
});

const awaitSocket = Effect.fn("TestRpcSessionFactory.awaitSocket")(function* (
  sockets: ReadonlyArray<TestWebSocket>,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const socket = sockets[0];
    if (socket) {
      return socket;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to create a websocket."));
});

const awaitRequest = Effect.fn("TestRpcSessionFactory.awaitRequest")(function* (
  socket: TestWebSocket,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const request = socket.sent[0];
    if (request) {
      return decodeRpcRequest(decodeJson(request));
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to send a request."));
});

const completeInitialConfig = Effect.fn("TestRpcSessionFactory.completeInitialConfig")(function* (
  socket: TestWebSocket,
) {
  const request = yield* awaitRequest(socket);
  expect(request).toMatchObject({
    _tag: "Request",
    tag: WS_METHODS.serverGetConfig,
    payload: {},
  });
  socket.serverMessage(
    encodeJson({
      _tag: "Exit",
      requestId: request.id,
      exit: {
        _tag: "Success",
        value: encodeServerConfig(SERVER_CONFIG),
      },
    }),
  );
});

describe("RpcSessionFactory", () => {
  it.effect("owns one scoped websocket attempt and exposes readiness and closure", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);

      expect(socket.url).toBe(PREPARED.socketUrl);
      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      const config = yield* session.initialConfig;
      expect(config).toEqual(SERVER_CONFIG);
      expect(socket.sent).toHaveLength(1);

      socket.close(1012, "service restart");
      const error = yield* Effect.flip(session.closed);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "transport",
        message: "Test environment disconnected.",
      });
      yield* Effect.yieldNow;
      expect(sockets).toHaveLength(1);
    }),
  );

  it.effect("closes the websocket when the session scope is released", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          const readyFiber = yield* Effect.forkChild(session.ready);
          const socket = yield* awaitSocket(sockets);
          socket.open();
          yield* completeInitialConfig(socket);
          yield* Fiber.join(readyFiber);
        }),
      );

      expect(sockets[0]?.readyState).toBe(TestWebSocket.CLOSED);
    }),
  );

  it.effect("fails readiness when the websocket never opens", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          const readyFiber = yield* Effect.forkChild(Effect.flip(session.ready));
          yield* awaitSocket(sockets);

          yield* TestClock.adjust("15 seconds");
          return yield* Fiber.join(readyFiber);
        }),
      );

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "transport",
        message: "Test environment could not establish a WebSocket connection.",
      });
      expect(sockets[0]?.readyState).toBe(TestWebSocket.CLOSED);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
