import {
  CommandId,
  type ContextMenuItem,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_CHANNELS,
  type ServerProviderStatus,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.fn<(...args: Array<unknown>) => Promise<unknown>>();
const showContextMenuFallbackMock = vi.fn<
  <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>
>();
const channelListeners = new Map<string, Set<(data: unknown) => void>>();
const subscribeMock = vi.fn<(channel: string, listener: (data: unknown) => void) => () => void>(
  (channel, listener) => {
    const listeners = channelListeners.get(channel) ?? new Set<(data: unknown) => void>();
    listeners.add(listener);
    channelListeners.set(channel, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        channelListeners.delete(channel);
      }
    };
  },
);

vi.mock("./wsTransport", () => {
  return {
    WsTransport: class MockWsTransport {
      request = requestMock;
      subscribe = subscribeMock;
    },
  };
});

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

function emitPush(channel: string, data: unknown): void {
  const listeners = channelListeners.get(channel);
  if (!listeners) return;
  for (const listener of listeners) {
    listener(data);
  }
}

function getWindowForTest(): Window & typeof globalThis & { desktopBridge?: unknown } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { desktopBridge?: unknown };
  };
  if (!testGlobal.window) {
    testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
  }
  return testGlobal.window;
}

const defaultProviders: ReadonlyArray<ServerProviderStatus> = [
  {
    provider: "codex",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-01-01T00:00:00.000Z",
  },
];

beforeEach(() => {
  vi.resetModules();
  requestMock.mockReset();
  showContextMenuFallbackMock.mockReset();
  subscribeMock.mockClear();
  channelListeners.clear();
  Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wsNativeApi", () => {
  it("delivers and caches valid server.welcome payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    const payload = { cwd: "/tmp/workspace", projectName: "t3-code" };
    emitPush(WS_CHANNELS.serverWelcome, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining(payload));

    const lateListener = vi.fn();
    onServerWelcome(lateListener);

    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(expect.objectContaining(payload));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("preserves bootstrap ids from server.welcome payloads", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    emitPush(WS_CHANNELS.serverWelcome, {
      cwd: "/tmp/workspace",
      projectName: "t3-code",
      bootstrapProjectId: "project-1",
      bootstrapThreadId: "thread-1",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/workspace",
        projectName: "t3-code",
        bootstrapProjectId: "project-1",
        bootstrapThreadId: "thread-1",
      }),
    );
  });

  it("ignores invalid server.welcome payloads and keeps subscription active", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    emitPush(WS_CHANNELS.serverWelcome, { cwd: 42, projectName: "t3-code" });
    emitPush(WS_CHANNELS.serverWelcome, { cwd: "/tmp/workspace", projectName: "t3-code" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/workspace", projectName: "t3-code" }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("Dropped inbound WebSocket push payload", {
      reason: "decode-failed",
      raw: { cwd: 42, projectName: "t3-code" },
      issue: expect.stringContaining("SchemaError"),
    });
  });

  it("delivers and caches valid server.configUpdated payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi, onServerConfigUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerConfigUpdated(listener);

    const payload = {
      issues: [
        {
          kind: "keybindings.invalid-entry",
          index: 1,
          message: "Entry at index 1 is invalid.",
        },
      ],
      providers: defaultProviders,
    } as const;
    emitPush(WS_CHANNELS.serverConfigUpdated, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);

    const lateListener = vi.fn();
    onServerConfigUpdated(lateListener);
    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(payload);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("drops malformed server.configUpdated payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi, onServerConfigUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerConfigUpdated(listener);

    emitPush(WS_CHANNELS.serverConfigUpdated, {
      issues: [{ kind: "keybindings.invalid-entry", message: "missing index" }],
      providers: defaultProviders,
    });
    emitPush(WS_CHANNELS.serverConfigUpdated, {
      issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
      providers: defaultProviders,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
      providers: defaultProviders,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards valid terminal and orchestration events", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const onTerminalEvent = vi.fn();
    const onDomainEvent = vi.fn();

    api.terminal.onEvent(onTerminalEvent);
    api.orchestration.onDomainEvent(onDomainEvent);

    const terminalEvent = {
      threadId: "thread-1",
      terminalId: "terminal-1",
      createdAt: "2026-02-24T00:00:00.000Z",
      type: "output",
      data: "hello",
    } as const;
    emitPush(WS_CHANNELS.terminalEvent, terminalEvent);

    const orchestrationEvent = {
      sequence: 1,
      eventId: "event-1",
      aggregateKind: "project",
      aggregateId: "project-1",
      occurredAt: "2026-02-24T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: "project-1",
        title: "Project",
        workspaceRoot: "/tmp/workspace",
        defaultModel: null,
        scripts: [],
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
      },
    } as const;
    emitPush(ORCHESTRATION_WS_CHANNELS.domainEvent, orchestrationEvent);

    expect(onTerminalEvent).toHaveBeenCalledTimes(1);
    expect(onTerminalEvent).toHaveBeenCalledWith(terminalEvent);
    expect(onDomainEvent).toHaveBeenCalledTimes(1);
    expect(onDomainEvent).toHaveBeenCalledWith(orchestrationEvent);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("drops malformed terminal and orchestration push payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const onTerminalEvent = vi.fn();
    const onDomainEvent = vi.fn();

    api.terminal.onEvent(onTerminalEvent);
    api.orchestration.onDomainEvent(onDomainEvent);

    emitPush(WS_CHANNELS.terminalEvent, {
      threadId: "thread-1",
      terminalId: "",
      createdAt: "2026-02-24T00:00:00.000Z",
      type: "output",
      data: "hello",
    });
    emitPush(ORCHESTRATION_WS_CHANNELS.domainEvent, {
      sequence: -1,
      type: "project.created",
    });

    expect(onTerminalEvent).not.toHaveBeenCalled();
    expect(onDomainEvent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(1, "Dropped inbound WebSocket push payload", {
      reason: "decode-failed",
      raw: {
        threadId: "thread-1",
        terminalId: "",
        createdAt: "2026-02-24T00:00:00.000Z",
        type: "output",
        data: "hello",
      },
      issue: expect.stringContaining("SchemaError"),
    });
    expect(warnSpy).toHaveBeenNthCalledWith(2, "Dropped inbound WebSocket push payload", {
      reason: "decode-failed",
      raw: {
        sequence: -1,
        type: "project.created",
      },
      issue: expect.stringContaining("SchemaError"),
    });
  });

  it("wraps orchestration dispatch commands in the command envelope", async () => {
    requestMock.mockResolvedValue(undefined);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const command = {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModel: "gpt-5-codex",
      createdAt: "2026-02-24T00:00:00.000Z",
    } as const;
    await api.orchestration.dispatchCommand(command);

    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command,
    });
  });

  it("forwards full-thread diff requests to the orchestration websocket method", async () => {
    requestMock.mockResolvedValue({ diff: "patch" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.orchestration.getFullThreadDiff({
      threadId: ThreadId.makeUnsafe("thread-1"),
      toTurnCount: 1,
    });

    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
      threadId: "thread-1",
      toTurnCount: 1,
    });
  });

  it("forwards context menu metadata to desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        showContextMenu,
      },
    });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.contextMenu.show(
      [
        { id: "rename", label: "Rename thread" },
        { id: "delete", label: "Delete", destructive: true },
      ],
      { x: 200, y: 300 },
    );

    expect(showContextMenu).toHaveBeenCalledWith(
      [
        { id: "rename", label: "Rename thread" },
        { id: "delete", label: "Delete", destructive: true },
      ],
      { x: 200, y: 300 },
    );
  });

  it("uses fallback context menu when desktop bridge is unavailable", async () => {
    showContextMenuFallbackMock.mockResolvedValue("delete");
    Reflect.deleteProperty(getWindowForTest(), "desktopBridge");

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.contextMenu.show(
      [{ id: "delete", label: "Delete", destructive: true }],
      { x: 20, y: 30 },
    );

    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(
      [{ id: "delete", label: "Delete", destructive: true }],
      { x: 20, y: 30 },
    );
  });
});
