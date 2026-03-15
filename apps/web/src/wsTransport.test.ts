import { WS_METHODS } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  private emit(type: WsEventType, event?: WsEvent) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

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

beforeEach(() => {
  sockets.length = 0;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { hostname: "localhost", port: "3020", protocol: "ws:" },
      desktopBridge: undefined,
    },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.restoreAllMocks();
});

describe("WsTransport", () => {
  it("normalizes root websocket urls to /ws and preserves query params", async () => {
    const transport = new WsTransport("ws://localhost:3020/?token=secret-token");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("ws://localhost:3020/ws?token=secret-token");
    transport.dispose();
  });

  it("sends unary RPC requests and resolves successful exits", async () => {
    const transport = new WsTransport("ws://localhost:3020");

    const requestPromise = transport.request(WS_METHODS.serverUpsertKeybinding, {
      command: "terminal.toggle",
      key: "ctrl+k",
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    expect(socket.sent).toHaveLength(0);
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

    transport.dispose();
  });

  it("delivers stream chunks to subscribers", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const listener = vi.fn();

    const unsubscribe = transport.subscribe(WS_METHODS.subscribeServerLifecycle, {}, listener);
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
    transport.dispose();
  });

  it("re-subscribes stream listeners after the stream exits", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const listener = vi.fn();

    const unsubscribe = transport.subscribe(WS_METHODS.subscribeServerLifecycle, {}, listener);
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
    transport.dispose();
  });
});
