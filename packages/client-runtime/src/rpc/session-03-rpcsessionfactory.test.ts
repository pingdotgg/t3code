import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ServerConfig,
  type ServerConfig as ServerConfigType,
  ServerConfigStreamEvent,
  type ServerConfigStreamEvent as ServerConfigStreamEventType,
  WS_METHODS,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/socket/Socket";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "./session.ts";
import { makeEnvironmentServerConfigState } from "../state/server.ts";
import { applyServerConfigProjection } from "../state/serverConfigProjection.ts";

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
  readonly sentChanges: Queue.Queue<void>;
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  constructor(url: string, sentChanges: Queue.Queue<void>) {
    this.url = url;
    this.sentChanges = sentChanges;
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
    Queue.offerUnsafe(this.sentChanges, undefined);
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
      connectionProbe: true,
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
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/tmp/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.Union([Schema.String, Schema.Number]),
  payload: Schema.Unknown,
  tag: Schema.String,
});
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isRpcRequest = Schema.is(RpcRequest);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeServerConfig = Schema.encodeSync(ServerConfig);
const encodeServerConfigStreamEvent = Schema.encodeSync(ServerConfigStreamEvent);
const encodeDefect = Schema.encodeSync(Schema.Defect());
const ENCODED_SERVER_CONFIG = encodeServerConfig(SERVER_CONFIG);
const THEME_SERVER_CONFIG: ServerConfigType = {
  ...SERVER_CONFIG,
  environment: {
    ...SERVER_CONFIG.environment,
    capabilities: {
      ...SERVER_CONFIG.environment.capabilities,
      environmentThemes: true,
    },
  },
};
const ENCODED_THEME_SERVER_CONFIG = encodeServerConfig(THEME_SERVER_CONFIG);
const SOURCE_SERVER_CONFIG: ServerConfigType = {
  ...THEME_SERVER_CONFIG,
  environment: {
    ...THEME_SERVER_CONFIG.environment,
    capabilities: { ...THEME_SERVER_CONFIG.environment.capabilities, usageLimitSources: true },
  },
};
const SOURCE_EVENT: ServerConfigStreamEventType = {
  version: 1,
  type: "usageLimitSourcesUpdated",
  payload: {
    sources: [
      {
        id: UsageLimitSourceId.make("proxy"),
        kind: "cliproxy",
        label: "Proxy",
        checkedAt: "2026-09-04T00:00:00Z",
        accounts: [],
      },
    ],
  },
};

const makeFactory = Effect.fn("TestRpcSessionFactory.make")(function* (
  options: RpcSession.RpcSessionOptions = {},
) {
  const sentChanges = yield* Queue.unbounded<void>();
  const sockets = Object.assign([] as TestWebSocket[], { changes: yield* Queue.unbounded<void>() });
  const layerConstructor = Layer.succeed(Socket.WebSocketConstructor, (url) => {
    const socket = new TestWebSocket(url, sentChanges);
    sockets.push(socket);
    Queue.offerUnsafe(sockets.changes, undefined);
    return socket as unknown as globalThis.WebSocket;
  });
  const layer = RpcSession.layer(options).pipe(Layer.provide(layerConstructor));
  const factory = yield* RpcSession.RpcSessionFactory.pipe(Effect.provide(layer));
  return { factory, sockets };
});

const awaitSocket = Effect.fn("TestRpcSessionFactory.awaitSocket")(function* (
  sockets: ReadonlyArray<TestWebSocket> & { readonly changes: Queue.Queue<void> },
  index = 0,
) {
  for (;;) {
    const socket = sockets[index];
    if (socket) {
      return socket;
    }
    yield* Queue.take(sockets.changes);
  }
});

const awaitRequest = Effect.fn("TestRpcSessionFactory.awaitRequest")(function* (
  socket: TestWebSocket,
  index = 0,
) {
  for (;;) {
    const request = socket.sent.map((message) => decodeJson(message)).filter(isRpcRequest)[index];
    if (request) {
      return request;
    }
    yield* Queue.take(socket.sentChanges);
  }
});

const completeInitialConfig = Effect.fn("TestRpcSessionFactory.completeInitialConfig")(function* (
  socket: TestWebSocket,
  config: unknown = ENCODED_SERVER_CONFIG,
  payload: unknown = {},
) {
  const request = yield* awaitRequest(socket);
  expect(request).toMatchObject({
    _tag: "Request",
    tag: WS_METHODS.subscribeServerConfig,
    payload,
  });
  socket.serverMessage(
    encodeJson({
      _tag: "Chunk",
      requestId: request.id,
      values: [{ version: 1, type: "snapshot", config }],
    }),
  );
});

const publishConfigEvents = Effect.fn("TestRpcSessionFactory.publishConfigEvents")(function* (
  socket: TestWebSocket,
  events: ReadonlyArray<ServerConfigStreamEventType>,
) {
  const request = yield* awaitRequest(socket);
  socket.serverMessage(
    encodeJson({
      _tag: "Chunk",
      requestId: request.id,
      values: events.map((event) => encodeServerConfigStreamEvent(event)),
    }),
  );
});



describe("RpcSessionFactory", () => {
  it.effect("reaches ready when a newer server sends unknown config members", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);
      socket.open();

      const shortcut = {
        key: "p",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      };
      yield* completeInitialConfig(socket, {
        ...ENCODED_SERVER_CONFIG,
        keybindings: [
          { command: "someFuture.toggle", shortcut },
          { command: "terminal.toggle", shortcut },
        ],
        issues: [{ kind: "keybindings.future-issue", message: "From a newer server" }],
        availableEditors: ["some-future-editor", "zed"],
      });
      yield* Fiber.join(readyFiber);

      const config = yield* session.initialConfig;
      expect(config.keybindings).toEqual([{ command: "terminal.toggle", shortcut }]);
      expect(config.issues).toEqual([]);
      expect(config.availableEditors).toEqual(["zed"]);
    }),
  );
});

