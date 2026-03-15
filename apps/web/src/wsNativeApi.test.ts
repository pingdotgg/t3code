import {
  CommandId,
  type ContextMenuItem,
  EventId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  type OrchestrationEvent,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProviderStatus,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.fn<(...args: Array<unknown>) => Promise<unknown>>();
const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();
const streamListeners = new Map<string, Set<(event: unknown) => void>>();
const subscribeMock = vi.fn<
  (method: string, params: unknown, listener: (event: unknown) => void) => () => void
>((method, _params, listener) => {
  const listeners = streamListeners.get(method) ?? new Set<(event: unknown) => void>();
  listeners.add(listener);
  streamListeners.set(method, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      streamListeners.delete(method);
    }
  };
});

vi.mock("./wsTransport", () => {
  return {
    WsTransport: class MockWsTransport {
      request = requestMock;
      subscribe = subscribeMock;
      dispose() {}
    },
  };
});

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

function emitStreamEvent(method: string, event: unknown) {
  const listeners = streamListeners.get(method);
  if (!listeners) {
    return;
  }
  for (const listener of listeners) {
    listener(event);
  }
}

function emitLifecycleEvent(event: ServerLifecycleStreamEvent) {
  emitStreamEvent(WS_METHODS.subscribeServerLifecycle, event);
}

function emitServerConfigEvent(event: ServerConfigStreamEvent) {
  emitStreamEvent(WS_METHODS.subscribeServerConfig, event);
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

const baseServerConfig: ServerConfig = {
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/.config/keybindings.json",
  keybindings: [],
  issues: [],
  providers: defaultProviders,
  availableEditors: ["cursor"],
};

beforeEach(() => {
  vi.resetModules();
  requestMock.mockReset();
  showContextMenuFallbackMock.mockReset();
  subscribeMock.mockClear();
  streamListeners.clear();
  Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wsNativeApi", () => {
  it("delivers and caches welcome lifecycle events", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    emitLifecycleEvent({
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: { cwd: "/tmp/workspace", projectName: "t3-code" },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      cwd: "/tmp/workspace",
      projectName: "t3-code",
    });

    const lateListener = vi.fn();
    onServerWelcome(lateListener);

    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith({
      cwd: "/tmp/workspace",
      projectName: "t3-code",
    });
  });

  it("preserves bootstrap ids from welcome lifecycle events", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    emitLifecycleEvent({
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        cwd: "/tmp/workspace",
        projectName: "t3-code",
        bootstrapProjectId: ProjectId.makeUnsafe("project-1"),
        bootstrapThreadId: ThreadId.makeUnsafe("thread-1"),
      },
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

  it("delivers and caches current server config from the config stream snapshot", async () => {
    const { createWsNativeApi, onServerConfigUpdated } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const listener = vi.fn();
    onServerConfigUpdated(listener);

    const pendingConfig = api.server.getConfig();
    emitServerConfigEvent({
      version: 1,
      type: "snapshot",
      config: baseServerConfig,
    });

    await expect(pendingConfig).resolves.toEqual(baseServerConfig);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      {
        issues: [],
        providers: defaultProviders,
      },
      "snapshot",
    );

    const lateListener = vi.fn();
    onServerConfigUpdated(lateListener);

    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(
      {
        issues: [],
        providers: defaultProviders,
      },
      "snapshot",
    );
  });

  it("merges config stream updates into the cached server config", async () => {
    const { createWsNativeApi, onServerConfigUpdated } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const listener = vi.fn();
    onServerConfigUpdated(listener);

    emitServerConfigEvent({
      version: 1,
      type: "snapshot",
      config: baseServerConfig,
    });
    emitServerConfigEvent({
      version: 1,
      type: "keybindingsUpdated",
      payload: {
        issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
      },
    });

    const nextProviders: ReadonlyArray<ServerProviderStatus> = [
      {
        provider: "codex",
        status: "warning",
        available: true,
        authStatus: "authenticated",
        checkedAt: "2026-01-02T00:00:00.000Z",
        message: "rate limited",
      },
    ];
    emitServerConfigEvent({
      version: 1,
      type: "providerStatuses",
      payload: {
        providers: nextProviders,
      },
    });

    await expect(api.server.getConfig()).resolves.toEqual({
      ...baseServerConfig,
      issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
      providers: nextProviders,
    });
    expect(listener).toHaveBeenNthCalledWith(
      1,
      {
        issues: [],
        providers: defaultProviders,
      },
      "snapshot",
    );
    expect(listener).toHaveBeenNthCalledWith(
      2,
      {
        issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
        providers: defaultProviders,
      },
      "keybindingsUpdated",
    );
    expect(listener).toHaveBeenLastCalledWith(
      {
        issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
        providers: nextProviders,
      },
      "providerStatuses",
    );
  });

  it("forwards terminal and orchestration stream events", async () => {
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
    emitStreamEvent(WS_METHODS.subscribeTerminalEvents, terminalEvent);

    const orchestrationEvent = {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-1"),
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      occurredAt: "2026-02-24T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/workspace",
        defaultModel: null,
        scripts: [],
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
      },
    } satisfies Extract<OrchestrationEvent, { type: "project.created" }>;
    emitStreamEvent(WS_METHODS.subscribeOrchestrationDomainEvents, orchestrationEvent);

    expect(onTerminalEvent).toHaveBeenCalledTimes(1);
    expect(onTerminalEvent).toHaveBeenCalledWith(terminalEvent);
    expect(onDomainEvent).toHaveBeenCalledTimes(1);
    expect(onDomainEvent).toHaveBeenCalledWith(orchestrationEvent);
  });

  it("sends orchestration dispatch commands as the direct RPC payload", async () => {
    requestMock.mockResolvedValue({ sequence: 1 });
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

    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.dispatchCommand, command);
  });

  it("forwards workspace file writes to the project RPC", async () => {
    requestMock.mockResolvedValue({ relativePath: "plan.md" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.projects.writeFile({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.projectsWriteFile, {
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });
  });

  it("forwards full-thread diff requests to the orchestration RPC", async () => {
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

  it("uses the config snapshot promise for server.getConfig consumers", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const configPromise = api.server.getConfig();

    emitServerConfigEvent({
      version: 1,
      type: "snapshot",
      config: baseServerConfig,
    });

    await expect(configPromise).resolves.toEqual(baseServerConfig);
  });

  it("forwards context menu metadata to the desktop bridge", async () => {
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

  it("uses the fallback context menu when the desktop bridge is unavailable", async () => {
    showContextMenuFallbackMock.mockResolvedValue("delete");
    Reflect.deleteProperty(getWindowForTest(), "desktopBridge");

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.contextMenu.show([{ id: "delete", label: "Delete", destructive: true }], {
      x: 20,
      y: 30,
    });

    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(
      [{ id: "delete", label: "Delete", destructive: true }],
      { x: 20, y: 30 },
    );
  });
});
