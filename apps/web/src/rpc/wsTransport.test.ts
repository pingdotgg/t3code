import { DEFAULT_SERVER_SETTINGS, ServerSettings, WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetClientTracingForTests,
  configureClientTracing,
} from "../observability/clientTracing";
import {
  getSlowRpcAckRequests,
  resetRequestLatencyStateForTests,
  setSlowRpcAckThresholdMsForTests,
} from "../rpc/requestLatencyState";
import {
  getWsConnectionStatus,
  getWsConnectionUiState,
  resetWsConnectionStateForTests,
} from "../rpc/wsConnectionState";
import { WsTransport } from "./wsTransport";

const encodeServerSettings = Schema.encodeSync(ServerSettings);

type WsEventType = "open" | "message" | "close" | "error";
type WsEvent = { code?: number; data?: unknown; reason?: string; type?: string };
type WsListener = (event?: WsEvent) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: unknown) {
    this.emit("message", { data, type: "message" });
  }

  error() {
    this.emit("error", { type: "error" });
  }

  private emit(type: WsEventType, event?: WsEvent) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
const transports: WsTransport[] = [];

function getSocket(): MockWebSocket {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("Expected a websocket instance");
  }
  return socket;
}

async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function createTransport(...args: ConstructorParameters<typeof WsTransport>): WsTransport {
  const transport = new WsTransport(...args);
  transports.push(transport);
  return transport;
}

beforeEach(() => {
  vi.useRealTimers();
  sockets.length = 0;
  transports.length = 0;
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "http://localhost:3020",
        hostname: "localhost",
        port: "3020",
        protocol: "http:",
      },
      desktopBridge: undefined,
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: true },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(async () => {
  await Promise.allSettled(transports.map((transport) => transport.dispose()));
  transports.length = 0;
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();
  await __resetClientTracingForTests();
  vi.restoreAllMocks();
});

describe("WsTransport (web instrumentation)", () => {
  it("tracks initial connection failures for the app error state", async () => {
    const transport = createTransport("ws://localhost:3020");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    expect(getWsConnectionStatus()).toMatchObject({
      attemptCount: 1,
      phase: "connecting",
      socketUrl: "ws://localhost:3020/ws",
    });

    socket.error();
    socket.close(1006, "server unavailable");

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        closeCode: 1006,
        closeReason: "server unavailable",
        hasConnected: false,
        lastError: "Unable to connect to the T3 server WebSocket.",
        phase: "disconnected",
      });
    });
    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("error");

    await transport.dispose();
  });

  it("surfaces reconnecting state after a live socket disconnects", async () => {
    const transport = createTransport("ws://localhost:3020");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    socket.close(1013, "try again later");

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        closeReason: "try again later",
        hasConnected: true,
      });
    });
    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("reconnecting");

    await transport.dispose();
  });

  it("composes custom lifecycle handlers with default websocket state tracking", async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const transport = createTransport("ws://localhost:3020", {
      onOpen,
      onClose,
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(onOpen).toHaveBeenCalledOnce();
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    socket.close(1012, "service restart");

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledWith(
        {
          code: 1012,
          reason: "service restart",
        },
        {
          intentional: false,
        },
      );
      expect(getWsConnectionStatus()).toMatchObject({
        attemptCount: 2,
        closeReason: "service restart",
        phase: "connecting",
      });
    }, 2_000);

    await transport.dispose();
  });

  it("marks unary requests as slow until the first server ack arrives", async () => {
    const slowAckThresholdMs = 25;
    setSlowRpcAckThresholdMsForTests(slowAckThresholdMs);
    const transport = createTransport("ws://localhost:3020");

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "terminal.toggle",
        key: "ctrl+k",
      }),
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    await waitFor(() => {
      expect(getSlowRpcAckRequests()).toMatchObject([
        {
          requestId: requestMessage.id,
          tag: WS_METHODS.serverUpsertKeybinding,
        },
      ]);
    }, 1_000);

    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: {
            keybindings: [],
            issues: [],
          },
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      keybindings: [],
      issues: [],
    });
    expect(getSlowRpcAckRequests()).toEqual([]);

    await transport.dispose();
  }, 5_000);

  it("clears slow unary request tracking when the transport reconnects", async () => {
    const slowAckThresholdMs = 25;
    setSlowRpcAckThresholdMsForTests(slowAckThresholdMs);
    const transport = createTransport("ws://localhost:3020");

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "terminal.toggle",
        key: "ctrl+k",
      }),
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    await waitFor(() => {
      expect(firstSocket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(firstSocket.sent[0] ?? "{}") as { id: string };

    await waitFor(() => {
      expect(getSlowRpcAckRequests()).toMatchObject([
        {
          requestId: firstRequest.id,
          tag: WS_METHODS.serverUpsertKeybinding,
        },
      ]);
    }, 1_000);

    void requestPromise.catch(() => undefined);

    await transport.reconnect();

    expect(getSlowRpcAckRequests()).toEqual([]);

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket();
    secondSocket.open();

    await transport.dispose();
  }, 5_000);

  it("propagates OTLP trace ids for ws transport requests when client tracing is enabled", async () => {
    await configureClientTracing({
      exportIntervalMs: 10,
    });

    const transport = createTransport("ws://localhost:3020");
    const requestPromise = transport.request((client) => client[WS_METHODS.serverGetSettings]({}));

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as {
      id: string;
      spanId?: string;
      traceId?: string;
    };
    expect(requestMessage.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(requestMessage.spanId).toMatch(/^[0-9a-f]{16}$/);

    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: encodeServerSettings(DEFAULT_SERVER_SETTINGS),
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual(DEFAULT_SERVER_SETTINGS);
    await transport.dispose();
  });
});
