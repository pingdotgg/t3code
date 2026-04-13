import { DEFAULT_SERVER_SETTINGS, WS_METHODS } from "@t3tools/contracts";
import { Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("WsTransport", () => {
  it("normalizes root websocket urls to /ws and preserves query params", async () => {
    const transport = createTransport("ws://localhost:3020/?token=secret-token");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("ws://localhost:3020/ws?token=secret-token");
    await transport.dispose();
  });

  it("uses an explicit secure websocket base url", async () => {
    const transport = createTransport("wss://app.example.com");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("wss://app.example.com/ws");
    await transport.dispose();
  });

  it("uses an explicit insecure websocket base url for remote backends", async () => {
    const transport = createTransport("ws://192.168.1.44:3773");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("ws://192.168.1.44:3773/ws");
    await transport.dispose();
  });

  it("supports async websocket url providers", async () => {
    const transport = createTransport(async () => "wss://remote.example.com/?wsToken=dynamic");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("wss://remote.example.com/ws?wsToken=dynamic");
    await transport.dispose();
  });

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
      expect(onClose).toHaveBeenCalledWith({
        code: 1012,
        reason: "service restart",
      });
      expect(getWsConnectionStatus()).toMatchObject({
        attemptCount: 2,
        closeReason: "service restart",
        phase: "connecting",
      });
    }, 2_000);

    await transport.dispose();
  });

  it("reconnects the websocket session without disposing the transport", async () => {
    const transport = createTransport("ws://localhost:3020");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket();
    expect(secondSocket).not.toBe(firstSocket);
    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "terminal.toggle",
        key: "ctrl+k",
      }),
    );

    secondSocket.open();

    await waitFor(() => {
      expect(secondSocket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(secondSocket.sent[0] ?? "{}") as { id: string };
    secondSocket.serverMessage(
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

  it("sends unary RPC requests and resolves successful exits", async () => {
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

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as {
      _tag: string;
      id: string;
      payload: unknown;
      tag: string;
    };
    expect(requestMessage).toMatchObject({
      _tag: "Request",
      tag: WS_METHODS.serverUpsertKeybinding,
      payload: {
        command: "terminal.toggle",
        key: "ctrl+k",
      },
    });

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

    await transport.dispose();
  });

  it("delivers stream chunks to subscribers", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string; tag: string };
    expect(requestMessage.tag).toBe(WS_METHODS.subscribeServerLifecycle);

    const welcomeEvent = {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    };

    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requestMessage.id,
        values: [welcomeEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenCalledWith(welcomeEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("re-subscribes stream listeners after the stream exits", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();
    const onResubscribe = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onResubscribe },
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [
          {
            version: 1,
            sequence: 1,
            type: "welcome",
            payload: {
              environment: {
                environmentId: "environment-local",
                label: "Local environment",
                platform: { os: "darwin", arch: "arm64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              },
              cwd: "/tmp/one",
              projectName: "one",
            },
          },
        ],
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: firstRequest.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await waitFor(() => {
      const nextRequest = socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; id?: string })
        .find((message) => message._tag === "Request" && message.id !== firstRequest.id);
      expect(nextRequest).toBeDefined();
    });
    expect(onResubscribe).toHaveBeenCalledOnce();

    const secondRequest = socket.sent
      .map((message) => JSON.parse(message) as { _tag?: string; id?: string; tag?: string })
      .find(
        (message): message is { _tag: "Request"; id: string; tag: string } =>
          message._tag === "Request" && message.id !== firstRequest.id,
      );
    if (!secondRequest) {
      throw new Error("Expected a resubscribe request");
    }
    expect(secondRequest.tag).toBe(WS_METHODS.subscribeServerLifecycle);
    expect(secondRequest.id).not.toBe(firstRequest.id);

    const secondEvent = {
      version: 1,
      sequence: 2,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/two",
        projectName: "two",
      },
    };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: secondRequest.id,
        values: [secondEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(secondEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("re-subscribes live stream listeners after an explicit transport reconnect", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();
    const onResubscribe = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onResubscribe },
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
    const firstEvent = {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/one",
        projectName: "one",
      },
    };

    firstSocket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [firstEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(firstEvent);
    });

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket();
    expect(secondSocket).not.toBe(firstSocket);
    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);

    secondSocket.open();

    await waitFor(() => {
      expect(secondSocket.sent).toHaveLength(1);
    });

    const secondRequest = JSON.parse(secondSocket.sent[0] ?? "{}") as {
      id: string;
      tag: string;
    };
    expect(secondRequest.tag).toBe(WS_METHODS.subscribeServerLifecycle);
    expect(secondRequest.id).not.toBe(firstRequest.id);
    expect(onResubscribe).toHaveBeenCalledOnce();

    const secondEvent = {
      version: 1,
      sequence: 2,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/two",
        projectName: "two",
      },
    };

    secondSocket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: secondRequest.id,
        values: [secondEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(secondEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("does not fire onResubscribe when the first stream attempt exits before any value", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();
    const onResubscribe = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onResubscribe },
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: firstRequest.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await waitFor(() => {
      const nextRequest = socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; id?: string })
        .find((message) => message._tag === "Request" && message.id !== firstRequest.id);
      expect(nextRequest).toBeDefined();
    });
    expect(onResubscribe).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    await transport.dispose();
  });

  it("does not retry stream subscriptions after application-level failures", async () => {
    const transport = createTransport("ws://localhost:3020");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;

    const unsubscribe = transport.subscribe(
      () =>
        Stream.suspend(() => {
          attempts += 1;
          return Stream.fail(new Error("Git command failed in GitCore.statusDetails"));
        }),
      vi.fn(),
      { retryDelay: 10 },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket().open();

    await waitFor(() => {
      expect(attempts).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(attempts).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription failed", {
      error: "Git command failed in GitCore.statusDetails",
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      "WebSocket RPC subscription disconnected",
      expect.anything(),
    );

    unsubscribe();
    await transport.dispose();
  });

  it("keeps retrying stream subscriptions after transport failures", async () => {
    const transport = createTransport("ws://localhost:3020");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;

    const unsubscribe = transport.subscribe(
      () =>
        Stream.suspend(() => {
          attempts += 1;
          return Stream.fail(new Error("SocketCloseError: WebSocket closed"));
        }),
      vi.fn(),
      { retryDelay: 10 },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket().open();

    await waitFor(() => {
      expect(attempts).toBeGreaterThanOrEqual(2);
    });

    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription disconnected", {
      error: "SocketCloseError: WebSocket closed",
    });

    unsubscribe();
    await transport.dispose();
  });

  it("logs a transport disconnect once even when multiple subscriptions fail together", async () => {
    const transport = createTransport("ws://localhost:3020");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const unsubscribeA = transport.subscribe(
      () => Stream.fail(new Error("SocketCloseError: 1006")),
      vi.fn(),
      { retryDelay: 10 },
    );
    const unsubscribeB = transport.subscribe(
      () => Stream.fail(new Error("SocketCloseError: 1006")),
      vi.fn(),
      { retryDelay: 10 },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket().open();

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription disconnected", {
      error: "SocketCloseError: 1006",
    });

    unsubscribeA();
    unsubscribeB();
    await transport.dispose();
  });

  it("streams finite request events without re-subscribing", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.requestStream(
      (client) =>
        client[WS_METHODS.gitRunStackedAction]({
          actionId: "action-1",
          cwd: "/repo",
          action: "commit",
        }),
      listener,
    );

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    const progressEvent = {
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      kind: "phase_started",
      phase: "commit",
      label: "Committing...",
    } as const;

    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requestMessage.id,
        values: [progressEvent],
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await expect(requestPromise).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledWith(progressEvent);
    expect(
      socket.sent.filter((message) => {
        const parsed = JSON.parse(message) as { _tag?: string; tag?: string };
        return parsed._tag === "Request" && parsed.tag === WS_METHODS.gitRunStackedAction;
      }),
    ).toHaveLength(1);
    await transport.dispose();
  });

  it("closes the client scope on the transport runtime before disposing the runtime", async () => {
    const callOrder: string[] = [];
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

    const runtime = {
      runPromise: vi.fn(async () => {
        callOrder.push("close:start");
        await closePromise;
        callOrder.push("close:done");
        return undefined;
      }),
      dispose: vi.fn(async () => {
        callOrder.push("runtime:dispose");
      }),
    };
    const transport = {
      disposed: false,
      session: {
        clientScope: {} as never,
        runtime,
      },
      closeSession: (
        WsTransport.prototype as unknown as {
          closeSession: (session: {
            clientScope: unknown;
            runtime: { dispose: () => Promise<void>; runPromise: () => Promise<void> };
          }) => Promise<void>;
        }
      ).closeSession,
    } as unknown as WsTransport;

    void WsTransport.prototype.dispose.call(transport);

    expect(runtime.runPromise).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect((transport as unknown as { disposed: boolean }).disposed).toBe(true);

    resolveClose();

    await waitFor(() => {
      expect(runtime.dispose).toHaveBeenCalledTimes(1);
    });

    expect(callOrder).toEqual(["close:start", "close:done", "runtime:dispose"]);
  });

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
          value: DEFAULT_SERVER_SETTINGS,
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual(DEFAULT_SERVER_SETTINGS);
    await transport.dispose();
  });
});
