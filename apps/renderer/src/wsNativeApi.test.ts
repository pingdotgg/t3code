import { beforeEach, describe, expect, it, vi } from "vitest";
import { WS_CLOSE_CODES, WS_CLOSE_REASONS } from "@acme/contracts";

type Listener = (event: unknown) => void;

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  static failSend = false;
  static failOpen = false;
  static failConstruct = false;
  static failCloseBeforeOpen = false;
  static failCloseBeforeOpenEvent: { code: number; reason?: string } = {
    code: WS_CLOSE_CODES.unauthorized,
    reason: WS_CLOSE_REASONS.unauthorized,
  };

  readyState = 0;
  binaryType = "blob";
  sentMessages: string[] = [];
  private listeners: Record<string, Listener[]> = {};

  constructor(readonly url: string) {
    if (MockWebSocket.failConstruct) {
      throw new Error("mock constructor failure");
    }
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (MockWebSocket.failCloseBeforeOpen) {
        this.readyState = 3;
        this.emit("close", MockWebSocket.failCloseBeforeOpenEvent);
        return;
      }
      if (MockWebSocket.failOpen) {
        this.emit("error", { message: "mock open failure" });
        return;
      }
      this.readyState = MockWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: Listener) {
    const next = this.listeners[type] ?? [];
    next.push(listener);
    this.listeners[type] = next;
  }

  send(data: string) {
    if (MockWebSocket.failSend) {
      throw new Error("mock send failure");
    }

    this.sentMessages.push(String(data));
  }

  close() {
    this.readyState = 3;
    this.emit("close", { code: 1000 });
  }

  closeWith(event: { code: number; reason?: string }) {
    this.readyState = 3;
    this.emit("close", event);
  }

  emitMessage(data: unknown) {
    this.emit("message", { data });
  }

  private emit(type: string, event: unknown) {
    const listeners = this.listeners[type] ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }
}

function setWindowSearch(search: string) {
  vi.stubGlobal("window", {
    location: {
      search,
    },
  });
}

function waitForCondition(check: () => boolean, timeoutMs = 1_000) {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for test condition."));
      }
    }, 10);
  });
}

async function waitForSocket() {
  await waitForCondition(() => MockWebSocket.instances.length > 0);
  const socket = MockWebSocket.instances[0];
  if (!socket) {
    throw new Error("Expected mock websocket instance.");
  }
  return socket;
}

describe("wsNativeApi", () => {
  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.instances = [];
    MockWebSocket.failSend = false;
    MockWebSocket.failOpen = false;
    MockWebSocket.failConstruct = false;
    MockWebSocket.failCloseBeforeOpen = false;
    MockWebSocket.failCloseBeforeOpenEvent = {
      code: WS_CLOSE_CODES.unauthorized,
      reason: WS_CLOSE_REASONS.unauthorized,
    };
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
  });

  it("connects using ws query parameter and resolves responses", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4400%3Ftoken%3Dabc");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();

    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    expect(socket?.url).toBe("ws://127.0.0.1:4400?token=abc");
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      type: string;
      id: string;
      method: string;
    };
    expect(requestEnvelope.type).toBe("request");
    expect(requestEnvelope.method).toBe("todos.list");

    socket?.emitMessage(
      JSON.stringify({
        type: "hello",
        version: 1,
        launchCwd: "/workspace",
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(request).resolves.toEqual([]);
  });

  it("configures websocket binaryType to arraybuffer", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4430");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = await waitForSocket();
    expect(socket.binaryType).toBe("arraybuffer");
    await waitForCondition(() => socket.sentMessages.length > 0);
    const requestEnvelope = JSON.parse(socket.sentMessages[0] ?? "{}") as {
      id: string;
    };
    socket.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );
    await expect(request).resolves.toEqual([]);
  });

  it("rejects immediately when websocket send throws", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4401");
    MockWebSocket.failSend = true;
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    await expect(api.todos.list()).rejects.toThrow(
      "Failed to send runtime request 'todos.list': mock send failure",
    );
  });

  it("sends app.health requests to runtime", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4411");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.app.health();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
      method: string;
    };
    expect(requestEnvelope.method).toBe("app.health");

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: {
          status: "ok",
          launchCwd: "/workspace",
          sessionCount: 0,
          activeClientConnected: true,
        },
      }),
    );

    await expect(request).resolves.toEqual({
      status: "ok",
      launchCwd: "/workspace",
      sessionCount: 0,
      activeClientConnected: true,
    });
  });

  it("sends app.bootstrap requests and returns payload", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4412");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.app.bootstrap();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
      method: string;
    };
    expect(requestEnvelope.method).toBe("app.bootstrap");

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: {
          launchCwd: "/workspace",
          projectName: "workspace",
          provider: "codex",
          model: "gpt-5-codex",
          session: {
            sessionId: "sess-1",
            provider: "codex",
            status: "ready",
            cwd: "/workspace",
            model: "gpt-5-codex",
            createdAt: "2026-02-01T00:00:00.000Z",
            updatedAt: "2026-02-01T00:00:00.000Z",
          },
        },
      }),
    );

    await expect(request).resolves.toMatchObject({
      launchCwd: "/workspace",
      provider: "codex",
      session: {
        sessionId: "sess-1",
      },
    });
  });

  it("preserves bootstrapError field in bootstrap payloads", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4420");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.app.bootstrap();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: {
          launchCwd: "/workspace",
          projectName: "workspace",
          provider: "codex",
          model: "gpt-5-codex",
          session: {
            sessionId: "bootstrap-error",
            provider: "codex",
            status: "error",
            cwd: "/workspace",
            model: "gpt-5-codex",
            createdAt: "2026-02-01T00:00:00.000Z",
            updatedAt: "2026-02-01T00:00:00.000Z",
            lastError: "Timed out waiting for initialize.",
          },
          bootstrapError: "Timed out waiting for initialize.",
        },
      }),
    );

    await expect(request).resolves.toMatchObject({
      bootstrapError: "Timed out waiting for initialize.",
      session: {
        status: "error",
      },
    });
  });

  it("falls back to default local runtime URL when ws query is missing", async () => {
    setWindowSearch("");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    expect(socket?.url).toBe("ws://127.0.0.1:4317");

    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(request).resolves.toEqual([]);
  });

  it("rejects request when runtime responds with structured error", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4402");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: false,
        error: {
          code: "request_failed",
          message: "boom",
        },
      }),
    );

    await expect(request).rejects.toThrow("boom");
  });

  it("ignores malformed error responses and still resolves matching response", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4431");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: false,
        error: {
          code: "request_failed",
        },
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(request).resolves.toEqual([]);
  });

  it("rejects pending requests when websocket disconnects", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4403");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    socket?.close();

    await expect(request).rejects.toThrow("websocket disconnected (code 1000)");
  });

  it("includes close reason details when pending request disconnects", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4450");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    socket?.closeWith({
      code: WS_CLOSE_CODES.unauthorized,
      reason: WS_CLOSE_REASONS.unauthorized,
    });

    await expect(request).rejects.toThrow("websocket disconnected (unauthorized)");
  });

  it("includes replacement details when pending request disconnects", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4453");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    socket?.closeWith({
      code: WS_CLOSE_CODES.replacedByNewClient,
      reason: WS_CLOSE_REASONS.replacedByNewClient,
    });

    await expect(request).rejects.toThrow("websocket disconnected (replaced-by-new-client)");
  });

  it("reconnects on subsequent requests after websocket close", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4428");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const firstRequest = api.todos.list();
    const firstSocket = await waitForSocket();
    await waitForCondition(() => firstSocket.sentMessages.length > 0);
    const firstEnvelope = JSON.parse(firstSocket.sentMessages[0] ?? "{}") as {
      id: string;
    };
    firstSocket.emitMessage(
      JSON.stringify({
        type: "response",
        id: firstEnvelope.id,
        ok: true,
        result: [],
      }),
    );
    await expect(firstRequest).resolves.toEqual([]);

    firstSocket.close();
    await waitForCondition(() => MockWebSocket.instances.length >= 1);

    const secondRequest = api.todos.list();
    await waitForCondition(() => MockWebSocket.instances.length >= 2);
    const secondSocket = MockWebSocket.instances[1];
    await waitForCondition(() => (secondSocket?.sentMessages.length ?? 0) > 0);
    const secondEnvelope = JSON.parse(secondSocket?.sentMessages[0] ?? "{}") as {
      id: string;
    };
    secondSocket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: secondEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(secondRequest).resolves.toEqual([]);
  });

  it("rejects requests when runtime does not respond before timeout", async () => {
    vi.useFakeTimers();
    try {
      setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4423");
      const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
      const api = getOrCreateWsNativeApi();

      const request = api.todos.list();
      await Promise.resolve();
      await Promise.resolve();

      vi.advanceTimersByTime(30_001);
      await expect(request).rejects.toThrow("Request timed out for method 'todos.list'.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues processing new requests after a timeout", async () => {
    vi.useFakeTimers();
    try {
      setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4424");
      const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
      const api = getOrCreateWsNativeApi();

      const firstRequest = api.todos.list();
      await Promise.resolve();
      await Promise.resolve();

      vi.advanceTimersByTime(30_001);
      await expect(firstRequest).rejects.toThrow("Request timed out for method 'todos.list'.");

      const socket = MockWebSocket.instances[0];
      const secondRequest = api.todos.list();
      await Promise.resolve();
      await Promise.resolve();
      const secondEnvelope = JSON.parse(socket?.sentMessages.at(-1) ?? "{}") as {
        id: string;
      };
      socket?.emitMessage(
        JSON.stringify({
          type: "response",
          id: secondEnvelope.id,
          ok: true,
          result: [],
        }),
      );

      await expect(secondRequest).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a stable cached native API instance", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4404");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");

    const first = getOrCreateWsNativeApi();
    const second = getOrCreateWsNativeApi();

    expect(second).toBe(first);
  });

  it("sends shell.openInEditor requests with expected payload", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4413");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.shell.openInEditor("/workspace", "cursor");
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
      method: string;
      params: { cwd: string; editor: string };
    };
    expect(requestEnvelope.method).toBe("shell.openInEditor");
    expect(requestEnvelope.params).toEqual({ cwd: "/workspace", editor: "cursor" });

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: null,
      }),
    );
    await expect(request).resolves.toBeUndefined();
  });

  it("sends terminal.run requests with expected payload", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4414");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.terminal.run({
      command: "pwd",
      cwd: "/workspace",
      timeoutMs: 5_000,
    });
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
      method: string;
      params: { command: string; cwd: string; timeoutMs: number };
    };
    expect(requestEnvelope.method).toBe("terminal.run");
    expect(requestEnvelope.params).toEqual({
      command: "pwd",
      cwd: "/workspace",
      timeoutMs: 5_000,
    });

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: {
          stdout: "/workspace\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        },
      }),
    );

    await expect(request).resolves.toMatchObject({
      stdout: "/workspace\n",
      code: 0,
      timedOut: false,
    });
  });

  it("sends dialogs.pickFolder requests and resolves value", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4417");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.dialogs.pickFolder();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
      method: string;
    };
    expect(requestEnvelope.method).toBe("dialogs.pickFolder");

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: "/workspace",
      }),
    );
    await expect(request).resolves.toBe("/workspace");
  });

  it("sends providers.listSessions requests and resolves payload", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4415");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.providers.listSessions();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
      method: string;
    };
    expect(requestEnvelope.method).toBe("providers.listSessions");

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [
          {
            sessionId: "sess-1",
            provider: "codex",
            status: "ready",
            cwd: "/workspace",
            model: "gpt-5-codex",
            createdAt: "2026-02-01T00:00:00.000Z",
            updatedAt: "2026-02-01T00:00:00.000Z",
          },
        ],
      }),
    );

    await expect(request).resolves.toMatchObject([
      {
        sessionId: "sess-1",
        provider: "codex",
      },
    ]);
  });

  it("sends provider turn-control requests with expected payloads", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4419");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const startRequest = api.providers.startSession({
      provider: "codex",
      cwd: "/workspace",
      model: "gpt-5-codex",
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
    });
    const socket = await waitForSocket();
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) >= 1);
    const startEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
      method: string;
      params: { provider: string; cwd: string; model: string };
    };
    expect(startEnvelope.method).toBe("providers.startSession");
    expect(startEnvelope.params).toMatchObject({
      provider: "codex",
      cwd: "/workspace",
      model: "gpt-5-codex",
    });
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: startEnvelope.id,
        ok: true,
        result: {
          sessionId: "sess-1",
          provider: "codex",
          status: "ready",
          cwd: "/workspace",
          model: "gpt-5-codex",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      }),
    );
    await expect(startRequest).resolves.toMatchObject({ sessionId: "sess-1" });

    const sendTurnRequest = api.providers.sendTurn({
      sessionId: "sess-1",
      input: "hello",
    });
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) >= 2);
    const sendTurnEnvelope = JSON.parse(socket?.sentMessages[1] ?? "{}") as {
      id: string;
      method: string;
      params: { sessionId: string; input: string };
    };
    expect(sendTurnEnvelope.method).toBe("providers.sendTurn");
    expect(sendTurnEnvelope.params).toEqual({ sessionId: "sess-1", input: "hello" });
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: sendTurnEnvelope.id,
        ok: true,
        result: {
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }),
    );
    await expect(sendTurnRequest).resolves.toMatchObject({ turnId: "turn-1" });

    const interruptRequest = api.providers.interruptTurn({
      sessionId: "sess-1",
      turnId: "turn-1",
    });
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) >= 3);
    const interruptEnvelope = JSON.parse(socket?.sentMessages[2] ?? "{}") as {
      id: string;
      method: string;
      params: { sessionId: string; turnId: string };
    };
    expect(interruptEnvelope.method).toBe("providers.interruptTurn");
    expect(interruptEnvelope.params).toEqual({ sessionId: "sess-1", turnId: "turn-1" });
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: interruptEnvelope.id,
        ok: true,
        result: null,
      }),
    );
    await expect(interruptRequest).resolves.toBeUndefined();

    const respondRequest = api.providers.respondToRequest({
      sessionId: "sess-1",
      requestId: "req-1",
      decision: "accept",
    });
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) >= 4);
    const respondEnvelope = JSON.parse(socket?.sentMessages[3] ?? "{}") as {
      id: string;
      method: string;
      params: { sessionId: string; requestId: string; decision: string };
    };
    expect(respondEnvelope.method).toBe("providers.respondToRequest");
    expect(respondEnvelope.params).toEqual({
      sessionId: "sess-1",
      requestId: "req-1",
      decision: "accept",
    });
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: respondEnvelope.id,
        ok: true,
        result: null,
      }),
    );
    await expect(respondRequest).resolves.toBeUndefined();

    const stopRequest = api.providers.stopSession({
      sessionId: "sess-1",
    });
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) >= 5);
    const stopEnvelope = JSON.parse(socket?.sentMessages[4] ?? "{}") as {
      id: string;
      method: string;
      params: { sessionId: string };
    };
    expect(stopEnvelope.method).toBe("providers.stopSession");
    expect(stopEnvelope.params).toEqual({ sessionId: "sess-1" });
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: stopEnvelope.id,
        ok: true,
        result: null,
      }),
    );
    await expect(stopRequest).resolves.toBeUndefined();
  });

  it("rejects provider control requests on structured runtime errors", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4421");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.providers.stopSession({
      sessionId: "sess-1",
    });
    const socket = await waitForSocket();
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) >= 1);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
      method: string;
    };
    expect(requestEnvelope.method).toBe("providers.stopSession");
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: false,
        error: {
          code: "request_failed",
          message: "provider stop failed",
        },
      }),
    );

    await expect(request).rejects.toThrow("provider stop failed");
  });

  it("sends todo mutation requests with expected payloads", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4416");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const addRequest = api.todos.add({
      title: "Write tests",
    });
    const socket = await waitForSocket();
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) >= 1, 5_000);
    const addEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
      method: string;
      params: { title: string };
    };
    expect(addEnvelope.method).toBe("todos.add");
    expect(addEnvelope.params).toEqual({ title: "Write tests" });
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: addEnvelope.id,
        ok: true,
        result: [
          {
            id: "todo-1",
            title: "Write tests",
            completed: false,
            createdAt: "2026-02-01T00:00:00.000Z",
          },
        ],
      }),
    );
    await expect(addRequest).resolves.toMatchObject([
      {
        id: "todo-1",
        completed: false,
      },
    ]);

    const toggleRequest = api.todos.toggle("todo-1");
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) >= 2, 5_000);
    const toggleEnvelope = JSON.parse(socket?.sentMessages[1] ?? "{}") as {
      id: string;
      method: string;
      params: string;
    };
    expect(toggleEnvelope.method).toBe("todos.toggle");
    expect(toggleEnvelope.params).toBe("todo-1");
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: toggleEnvelope.id,
        ok: true,
        result: [
          {
            id: "todo-1",
            title: "Write tests",
            completed: true,
            createdAt: "2026-02-01T00:00:00.000Z",
          },
        ],
      }),
    );
    await expect(toggleRequest).resolves.toMatchObject([
      {
        id: "todo-1",
        completed: true,
      },
    ]);

    const removeRequest = api.todos.remove("todo-1");
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) >= 3, 5_000);
    const removeEnvelope = JSON.parse(socket?.sentMessages[2] ?? "{}") as {
      id: string;
      method: string;
      params: string;
    };
    expect(removeEnvelope.method).toBe("todos.remove");
    expect(removeEnvelope.params).toBe("todo-1");
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: removeEnvelope.id,
        ok: true,
        result: [],
      }),
    );
    await expect(removeRequest).resolves.toEqual([]);
  });

  it("sends agent spawn/write/kill requests with expected payloads", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4418");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const spawnRequest = api.agent.spawn({
      command: "bash",
      args: ["-lc", "echo hi"],
      cwd: "/workspace",
    });
    const socket = await waitForSocket();
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) >= 1);
    const spawnEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
      method: string;
      params: { command: string; args: string[]; cwd: string };
    };
    expect(spawnEnvelope.method).toBe("agent.spawn");
    expect(spawnEnvelope.params).toEqual({
      command: "bash",
      args: ["-lc", "echo hi"],
      cwd: "/workspace",
    });
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: spawnEnvelope.id,
        ok: true,
        result: "agent-session-1",
      }),
    );
    await expect(spawnRequest).resolves.toBe("agent-session-1");

    const writeRequest = api.agent.write("agent-session-1", "input");
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) >= 2);
    const writeEnvelope = JSON.parse(socket?.sentMessages[1] ?? "{}") as {
      id: string;
      method: string;
      params: { sessionId: string; data: string };
    };
    expect(writeEnvelope.method).toBe("agent.write");
    expect(writeEnvelope.params).toEqual({ sessionId: "agent-session-1", data: "input" });
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: writeEnvelope.id,
        ok: true,
        result: null,
      }),
    );
    await expect(writeRequest).resolves.toBeUndefined();

    const killRequest = api.agent.kill("agent-session-1");
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) >= 3);
    const killEnvelope = JSON.parse(socket?.sentMessages[2] ?? "{}") as {
      id: string;
      method: string;
      params: string;
    };
    expect(killEnvelope.method).toBe("agent.kill");
    expect(killEnvelope.params).toBe("agent-session-1");
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: killEnvelope.id,
        ok: true,
        result: null,
      }),
    );
    await expect(killRequest).resolves.toBeUndefined();
  });

  it("rejects requests when websocket connection fails", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4405");
    MockWebSocket.failOpen = true;
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    await expect(api.todos.list()).rejects.toThrow("Failed to connect to local t3 runtime.");
  });

  it("rejects requests when websocket closes before opening", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4432");
    MockWebSocket.failCloseBeforeOpen = true;
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    await expect(api.todos.list()).rejects.toThrow(
      "Failed to connect to local t3 runtime: unauthorized websocket connection.",
    );
  });

  it("reports replacement details when websocket closes before opening", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4451");
    MockWebSocket.failCloseBeforeOpen = true;
    MockWebSocket.failCloseBeforeOpenEvent = {
      code: WS_CLOSE_CODES.replacedByNewClient,
      reason: WS_CLOSE_REASONS.replacedByNewClient,
    };
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    await expect(api.todos.list()).rejects.toThrow(
      "Failed to connect to local t3 runtime: replaced by a newer websocket client.",
    );
  });

  it("reports generic close code and reason when websocket closes before opening", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4452");
    MockWebSocket.failCloseBeforeOpen = true;
    MockWebSocket.failCloseBeforeOpenEvent = {
      code: 4200,
      reason: "custom-close",
    };
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    await expect(api.todos.list()).rejects.toThrow(
      "Failed to connect to local t3 runtime (close code 4200: custom-close).",
    );
  });

  it("recovers after websocket pre-open close on a later request", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4433");
    MockWebSocket.failCloseBeforeOpen = true;
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    await expect(api.todos.list()).rejects.toThrow(
      "Failed to connect to local t3 runtime: unauthorized websocket connection.",
    );

    MockWebSocket.failCloseBeforeOpen = false;
    const secondRequest = api.todos.list();
    await waitForCondition(() => MockWebSocket.instances.length >= 2);
    const socket = MockWebSocket.instances[1];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(secondRequest).resolves.toEqual([]);
  });

  it("recovers after websocket open failure on a later request", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4429");
    MockWebSocket.failOpen = true;
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    await expect(api.todos.list()).rejects.toThrow("Failed to connect to local t3 runtime.");

    MockWebSocket.failOpen = false;
    const secondRequest = api.todos.list();
    await waitForCondition(() => MockWebSocket.instances.length >= 2);
    const socket = MockWebSocket.instances[1];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(secondRequest).resolves.toEqual([]);
  });

  it("rejects requests when websocket construction throws", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4426");
    MockWebSocket.failConstruct = true;
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    await expect(api.todos.list()).rejects.toThrow("Failed to connect to local t3 runtime.");
  });

  it("recovers after websocket construction failure on next request", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4427");
    MockWebSocket.failConstruct = true;
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    await expect(api.todos.list()).rejects.toThrow("Failed to connect to local t3 runtime.");

    MockWebSocket.failConstruct = false;
    const secondRequest = api.todos.list();
    const socket = await waitForSocket();
    await waitForCondition(() => socket.sentMessages.length > 0);
    const requestEnvelope = JSON.parse(socket.sentMessages[0] ?? "{}") as {
      id: string;
    };

    socket.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(secondRequest).resolves.toEqual([]);
  });

  it("accepts arraybuffer server messages", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4406");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };

    const encoded = new TextEncoder().encode(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );
    socket?.emitMessage(encoded.buffer);

    await expect(request).resolves.toEqual([]);
  });

  it("accepts blob server messages", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4407");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };

    socket?.emitMessage(
      new Blob([
        JSON.stringify({
          type: "response",
          id: requestEnvelope.id,
          ok: true,
          result: [],
        }),
      ]),
    );

    await expect(request).resolves.toEqual([]);
  });

  it("ignores blob decode failures and continues processing", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4422");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };

    const originalBlobText = Blob.prototype.text;
    Blob.prototype.text = () => Promise.reject(new Error("decode failure"));
    try {
      socket?.emitMessage(new Blob(["invalid-json"]));
    } finally {
      Blob.prototype.text = originalBlobText;
    }

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(request).resolves.toEqual([]);
  });

  it("ignores invalid server messages and still resolves on valid response", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4408");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };

    socket?.emitMessage("not json");
    socket?.emitMessage(JSON.stringify({ type: "event", channel: "unknown", payload: null }));
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(request).resolves.toEqual([]);
  });

  it("ignores responses for unknown request ids", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4425");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: "unknown-request-id",
        ok: true,
        result: ["ignored"],
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(request).resolves.toEqual([]);
  });

  it("dispatches provider events to subscribers and supports unsubscribe", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4409");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const received: unknown[] = [];
    const unsubscribe = api.providers.onEvent((event) => {
      received.push(event);
    });

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );
    await expect(request).resolves.toEqual([]);

    const payload = {
      id: "evt-1",
      kind: "notification",
      provider: "codex",
      sessionId: "sess-1",
      createdAt: "2026-02-01T00:00:00.000Z",
      method: "turn/started",
    };
    socket?.emitMessage(
      JSON.stringify({
        type: "event",
        channel: "provider:event",
        payload,
      }),
    );
    await waitForCondition(() => received.length === 1);

    unsubscribe();
    socket?.emitMessage(
      JSON.stringify({
        type: "event",
        channel: "provider:event",
        payload: { ...payload, id: "evt-2" },
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(received).toHaveLength(1);
  });

  it("dispatches agent output and exit events to subscribers", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4410");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const outputEvents: unknown[] = [];
    const exitEvents: unknown[] = [];
    const unsubscribeOutput = api.agent.onOutput((event) => {
      outputEvents.push(event);
    });
    const unsubscribeExit = api.agent.onExit((event) => {
      exitEvents.push(event);
    });

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );
    await expect(request).resolves.toEqual([]);

    socket?.emitMessage(
      JSON.stringify({
        type: "event",
        channel: "agent:output",
        payload: {
          sessionId: "agent-session-1",
          stream: "stdout",
          data: "hello",
        },
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "event",
        channel: "agent:exit",
        payload: {
          sessionId: "agent-session-1",
          code: 0,
          signal: null,
        },
      }),
    );

    await waitForCondition(() => outputEvents.length === 1 && exitEvents.length === 1);

    unsubscribeOutput();
    unsubscribeExit();
    socket?.emitMessage(
      JSON.stringify({
        type: "event",
        channel: "agent:output",
        payload: {
          sessionId: "agent-session-1",
          stream: "stdout",
          data: "ignored",
        },
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "event",
        channel: "agent:exit",
        payload: {
          sessionId: "agent-session-1",
          code: 1,
          signal: null,
        },
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(outputEvents).toHaveLength(1);
    expect(exitEvents).toHaveLength(1);
  });
});
