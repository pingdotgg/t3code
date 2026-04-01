import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  type DesktopBridge,
  EventId,
  ProjectId,
  type OrchestrationEvent,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProvider,
  type TerminalEvent,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextMenuItem } from "@t3tools/contracts";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const lifecycleListeners = new Set<(event: ServerLifecycleStreamEvent) => void>();
const configListeners = new Set<(event: ServerConfigStreamEvent) => void>();
const terminalEventListeners = new Set<(event: TerminalEvent) => void>();
const orchestrationEventListeners = new Set<(event: OrchestrationEvent) => void>();

const rpcClientMock = {
  dispose: vi.fn(),
  terminal: {
    open: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    restart: vi.fn(),
    close: vi.fn(),
    onEvent: vi.fn((listener: (event: TerminalEvent) => void) =>
      registerListener(terminalEventListeners, listener),
    ),
  },
  projects: {
    searchEntries: vi.fn(),
    writeFile: vi.fn(),
  },
  shell: {
    openInEditor: vi.fn(),
  },
  git: {
    pull: vi.fn(),
    status: vi.fn(),
    runStackedAction: vi.fn(),
    listBranches: vi.fn(),
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    createBranch: vi.fn(),
    checkout: vi.fn(),
    init: vi.fn(),
    resolvePullRequest: vi.fn(),
    preparePullRequestThread: vi.fn(),
  },
  server: {
    getConfig: vi.fn(),
    refreshProviders: vi.fn(),
    upsertKeybinding: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    subscribeConfig: vi.fn((listener: (event: ServerConfigStreamEvent) => void) =>
      registerListener(configListeners, listener),
    ),
    subscribeLifecycle: vi.fn((listener: (event: ServerLifecycleStreamEvent) => void) =>
      registerListener(lifecycleListeners, listener),
    ),
  },
  orchestration: {
    getSnapshot: vi.fn(),
    dispatchCommand: vi.fn(),
    getTurnDiff: vi.fn(),
    getFullThreadDiff: vi.fn(),
    replayEvents: vi.fn(),
    onDomainEvent: vi.fn((listener: (event: OrchestrationEvent) => void) =>
      registerListener(orchestrationEventListeners, listener),
    ),
  },
};

vi.mock("./wsRpcClient", () => {
  return {
    getWsRpcClient: () => rpcClientMock,
    __resetWsRpcClientForTests: vi.fn(),
  };
});

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

function emitEvent<T>(listeners: Set<(event: T) => void>, event: T) {
  for (const listener of listeners) {
    listener(event);
  }
}

function emitLifecycleEvent(event: ServerLifecycleStreamEvent) {
  emitEvent(lifecycleListeners, event);
}

function emitServerConfigEvent(event: ServerConfigStreamEvent) {
  emitEvent(configListeners, event);
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

function makeDesktopBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    getWsUrl: () => null,
    pickFolder: async () => null,
    confirm: async () => true,
    setTheme: async () => undefined,
    showContextMenu: async () => null,
    openExternal: async () => true,
    onMenuAction: () => () => undefined,
    getUpdateState: async () => {
      throw new Error("getUpdateState not implemented in test");
    },
    checkForUpdate: async () => {
      throw new Error("checkForUpdate not implemented in test");
    },
    downloadUpdate: async () => {
      throw new Error("downloadUpdate not implemented in test");
    },
    installUpdate: async () => {
      throw new Error("installUpdate not implemented in test");
    },
    onUpdateState: () => () => undefined,
    ...overrides,
  };
}

const defaultProviders: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
  },
];

const baseServerConfig: ServerConfig = {
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/.config/keybindings.json",
  keybindings: [],
  issues: [],
  providers: defaultProviders,
  availableEditors: ["cursor"],
  settings: DEFAULT_SERVER_SETTINGS,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  showContextMenuFallbackMock.mockReset();
  lifecycleListeners.clear();
  configListeners.clear();
  terminalEventListeners.clear();
  orchestrationEventListeners.clear();
  Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wsNativeApi", () => {
  it("delivers and caches welcome lifecycle events", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");
    const { wsWelcomeAtom } = await import("./wsNativeApiState");
    const { appAtomRegistry } = await import("./rpc/atomRegistry");

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
    expect(appAtomRegistry.get(wsWelcomeAtom)).toEqual({
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
    const { serverConfigAtom } = await import("./wsNativeApiState");
    const { appAtomRegistry } = await import("./rpc/atomRegistry");

    const api = createWsNativeApi();
    const listener = vi.fn();
    onServerConfigUpdated(listener);

    emitServerConfigEvent({
      version: 1,
      type: "snapshot",
      config: baseServerConfig,
    });

    await expect(api.server.getConfig()).resolves.toEqual(baseServerConfig);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      {
        issues: [],
        providers: defaultProviders,
        settings: DEFAULT_SERVER_SETTINGS,
      },
      "snapshot",
    );
    expect(appAtomRegistry.get(serverConfigAtom)).toEqual(baseServerConfig);
  });

  it("falls back to server.getConfig before the stream cache is populated", async () => {
    rpcClientMock.server.getConfig.mockResolvedValueOnce(baseServerConfig);
    const { createWsNativeApi, onServerConfigUpdated } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const listener = vi.fn();
    onServerConfigUpdated(listener);

    await expect(api.server.getConfig()).resolves.toEqual(baseServerConfig);
    expect(rpcClientMock.server.getConfig).toHaveBeenCalledWith();
    expect(listener).toHaveBeenCalledWith(
      {
        issues: [],
        providers: defaultProviders,
        settings: DEFAULT_SERVER_SETTINGS,
      },
      "snapshot",
    );
  });

  it("merges config stream updates into the cached server config", async () => {
    const { createWsNativeApi, onServerConfigUpdated, onServerProvidersUpdated } =
      await import("./wsNativeApi");
    const { providersUpdatedAtom } = await import("./wsNativeApiState");
    const { appAtomRegistry } = await import("./rpc/atomRegistry");

    const api = createWsNativeApi();
    const configListener = vi.fn();
    const providersListener = vi.fn();
    onServerConfigUpdated(configListener);
    onServerProvidersUpdated(providersListener);

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

    const nextProviders: ReadonlyArray<ServerProvider> = [
      {
        ...defaultProviders[0]!,
        status: "warning",
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
    emitServerConfigEvent({
      version: 1,
      type: "settingsUpdated",
      payload: {
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          enableAssistantStreaming: true,
        },
      },
    });

    await expect(api.server.getConfig()).resolves.toEqual({
      ...baseServerConfig,
      issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
      providers: nextProviders,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        enableAssistantStreaming: true,
      },
    });
    expect(configListener).toHaveBeenNthCalledWith(
      1,
      {
        issues: [],
        providers: defaultProviders,
        settings: DEFAULT_SERVER_SETTINGS,
      },
      "snapshot",
    );
    expect(configListener).toHaveBeenNthCalledWith(
      2,
      {
        issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
        providers: defaultProviders,
        settings: DEFAULT_SERVER_SETTINGS,
      },
      "keybindingsUpdated",
    );
    expect(configListener).toHaveBeenNthCalledWith(
      3,
      {
        issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
        providers: nextProviders,
        settings: DEFAULT_SERVER_SETTINGS,
      },
      "providerStatuses",
    );
    expect(configListener).toHaveBeenLastCalledWith(
      {
        issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
        providers: nextProviders,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          enableAssistantStreaming: true,
        },
      },
      "settingsUpdated",
    );
    expect(providersListener).toHaveBeenLastCalledWith({ providers: nextProviders });
    expect(appAtomRegistry.get(providersUpdatedAtom)).toEqual({ providers: nextProviders });
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
    emitEvent(terminalEventListeners, terminalEvent);

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
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        scripts: [],
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
      },
    } satisfies Extract<OrchestrationEvent, { type: "project.created" }>;
    emitEvent(orchestrationEventListeners, orchestrationEvent);

    expect(onTerminalEvent).toHaveBeenCalledWith(terminalEvent);
    expect(onDomainEvent).toHaveBeenCalledWith(orchestrationEvent);
  });

  it("sends orchestration dispatch commands as the direct RPC payload", async () => {
    rpcClientMock.orchestration.dispatchCommand.mockResolvedValue({ sequence: 1 });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const command = {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      createdAt: "2026-02-24T00:00:00.000Z",
    } as const;
    await api.orchestration.dispatchCommand(command);

    expect(rpcClientMock.orchestration.dispatchCommand).toHaveBeenCalledWith(command);
  });

  it("forwards workspace file writes to the project RPC", async () => {
    rpcClientMock.projects.writeFile.mockResolvedValue({ relativePath: "plan.md" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.projects.writeFile({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });

    expect(rpcClientMock.projects.writeFile).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });
  });

  it("forwards full-thread diff requests to the orchestration RPC", async () => {
    rpcClientMock.orchestration.getFullThreadDiff.mockResolvedValue({ diff: "patch" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.orchestration.getFullThreadDiff({
      threadId: ThreadId.makeUnsafe("thread-1"),
      toTurnCount: 1,
    });

    expect(rpcClientMock.orchestration.getFullThreadDiff).toHaveBeenCalledWith({
      threadId: "thread-1",
      toTurnCount: 1,
    });
  });

  it("refreshes providers and updates cached listeners", async () => {
    const nextProviders: ReadonlyArray<ServerProvider> = [
      {
        ...defaultProviders[0]!,
        checkedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    rpcClientMock.server.refreshProviders.mockResolvedValue({ providers: nextProviders });
    const { createWsNativeApi, onServerProvidersUpdated } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    emitServerConfigEvent({
      version: 1,
      type: "snapshot",
      config: baseServerConfig,
    });

    const listener = vi.fn();
    onServerProvidersUpdated(listener);

    await expect(api.server.refreshProviders()).resolves.toEqual({ providers: nextProviders });
    expect(rpcClientMock.server.refreshProviders).toHaveBeenCalledWith();
    expect(listener).toHaveBeenLastCalledWith({ providers: nextProviders });
    await expect(api.server.getConfig()).resolves.toEqual({
      ...baseServerConfig,
      providers: nextProviders,
    });
  });

  it("updates cached config when server settings are changed", async () => {
    const nextSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableAssistantStreaming: true,
    };
    rpcClientMock.server.updateSettings.mockResolvedValue(nextSettings);
    const { createWsNativeApi, onServerConfigUpdated } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    emitServerConfigEvent({
      version: 1,
      type: "snapshot",
      config: baseServerConfig,
    });

    const listener = vi.fn();
    onServerConfigUpdated(listener);

    await expect(api.server.updateSettings({ enableAssistantStreaming: true })).resolves.toEqual(
      nextSettings,
    );
    expect(rpcClientMock.server.updateSettings).toHaveBeenCalledWith({
      enableAssistantStreaming: true,
    });
    await expect(api.server.getConfig()).resolves.toEqual({
      ...baseServerConfig,
      settings: nextSettings,
    });
    expect(listener).toHaveBeenLastCalledWith(
      {
        issues: [],
        providers: defaultProviders,
        settings: nextSettings,
      },
      "settingsUpdated",
    );
  });

  it("forwards context menu metadata to the desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    getWindowForTest().desktopBridge = makeDesktopBridge({ showContextMenu });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const items = [{ id: "delete", label: "Delete" }] as const;

    await expect(api.contextMenu.show(items)).resolves.toBe("delete");
    expect(showContextMenu).toHaveBeenCalledWith(items, undefined);
  });

  it("falls back to the browser context menu helper when the desktop bridge is missing", async () => {
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const items = [{ id: "rename", label: "Rename" }] as const;

    await expect(api.contextMenu.show(items, { x: 4, y: 5 })).resolves.toBe("rename");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 4, y: 5 });
  });
});
