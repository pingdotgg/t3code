import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getServerConfig,
  getServerKeybindings,
  onProvidersUpdated,
  onServerConfigUpdated,
  onWelcome,
  resetServerStateForTests,
  startServerStateSync,
} from "./serverState";

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

const lifecycleListeners = new Set<(event: ServerLifecycleStreamEvent) => void>();
const configListeners = new Set<(event: ServerConfigStreamEvent) => void>();

const defaultProviders: ReadonlyArray<ServerProvider> = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  },
];

const baseEnvironment = {
  environmentId: EnvironmentId.make("environment-local"),
  label: "Local environment",
  platform: {
    os: "darwin" as const,
    arch: "arm64" as const,
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};

const baseServerConfig: ServerConfig = {
  environment: baseEnvironment,
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-session-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/.config/keybindings.json",
  keybindings: [],
  issues: [],
  providers: defaultProviders,
  availableEditors: ["cursor"],
  observability: {
    logsDirectoryPath: "/tmp/workspace/.config/logs",
    localTracingEnabled: true,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

const serverApi = {
  getConfig: vi.fn<() => Promise<ServerConfig>>(),
  subscribeConfig: vi.fn((listener: (event: ServerConfigStreamEvent) => void) =>
    registerListener(configListeners, listener),
  ),
  subscribeLifecycle: vi.fn((listener: (event: ServerLifecycleStreamEvent) => void) =>
    registerListener(lifecycleListeners, listener),
  ),
};

function emitLifecycleEvent(event: ServerLifecycleStreamEvent) {
  for (const listener of lifecycleListeners) {
    listener(event);
  }
}

function emitServerConfigEvent(event: ServerConfigStreamEvent) {
  for (const listener of configListeners) {
    listener(event);
  }
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
  vi.clearAllMocks();
  lifecycleListeners.clear();
  configListeners.clear();
  resetServerStateForTests();
});

afterEach(() => {
  resetServerStateForTests();
});

describe("serverState", () => {
  it("uses default keybindings before a server config snapshot is available", () => {
    expect(getServerConfig()).toBeNull();
    expect(getServerKeybindings()).toEqual(DEFAULT_RESOLVED_KEYBINDINGS);
  });

  it("bootstraps the server config snapshot and replays it to late subscribers", async () => {
    serverApi.getConfig.mockResolvedValueOnce(baseServerConfig);

    const configListener = vi.fn();
    const stop = startServerStateSync(serverApi);
    const unsubscribe = onServerConfigUpdated(configListener);

    await waitFor(() => {
      expect(getServerConfig()).toEqual(baseServerConfig);
    });

    expect(serverApi.subscribeConfig).toHaveBeenCalledOnce();
    expect(serverApi.subscribeLifecycle).toHaveBeenCalledOnce();
    expect(serverApi.getConfig).toHaveBeenCalledOnce();
    expect(configListener).toHaveBeenCalledWith(
      {
        issues: [],
        providers: defaultProviders,
        settings: DEFAULT_SERVER_SETTINGS,
      },
      "snapshot",
    );

    const lateListener = vi.fn();
    const unsubscribeLate = onServerConfigUpdated(lateListener);
    expect(lateListener).toHaveBeenCalledWith(
      {
        issues: [],
        providers: defaultProviders,
        settings: DEFAULT_SERVER_SETTINGS,
      },
      "snapshot",
    );

    unsubscribeLate();
    unsubscribe();
    stop();
  });

  it("keeps the streamed snapshot when it arrives before the fallback fetch resolves", async () => {
    const deferred = createDeferredPromise<ServerConfig>();
    serverApi.getConfig.mockReturnValueOnce(deferred.promise);
    const stop = startServerStateSync(serverApi);

    const streamedConfig: ServerConfig = {
      ...baseServerConfig,
      cwd: "/tmp/from-stream",
    };

    emitServerConfigEvent({
      version: 1,
      type: "snapshot",
      config: streamedConfig,
    });

    await waitFor(() => {
      expect(getServerConfig()).toEqual(streamedConfig);
    });

    deferred.resolve(baseServerConfig);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getServerConfig()).toEqual(streamedConfig);
    stop();
  });

  it("replays welcome events to late subscribers", async () => {
    serverApi.getConfig.mockResolvedValueOnce(baseServerConfig);
    const stop = startServerStateSync(serverApi);

    const listener = vi.fn();
    const unsubscribe = onWelcome(listener);

    emitLifecycleEvent({
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment: baseEnvironment,
        cwd: "/tmp/workspace",
        projectName: "t3-code",
        bootstrapProjectId: ProjectId.make("project-1"),
        bootstrapThreadId: ThreadId.make("thread-1"),
      },
    });

    expect(listener).toHaveBeenCalledWith({
      environment: baseEnvironment,
      cwd: "/tmp/workspace",
      projectName: "t3-code",
      bootstrapProjectId: ProjectId.make("project-1"),
      bootstrapThreadId: ThreadId.make("thread-1"),
    });

    const lateListener = vi.fn();
    const unsubscribeLate = onWelcome(lateListener);
    expect(lateListener).toHaveBeenCalledWith({
      environment: baseEnvironment,
      cwd: "/tmp/workspace",
      projectName: "t3-code",
      bootstrapProjectId: ProjectId.make("project-1"),
      bootstrapThreadId: ThreadId.make("thread-1"),
    });

    unsubscribeLate();
    unsubscribe();
    stop();
  });

  it("merges provider, settings, and keybinding updates into the cached config", async () => {
    serverApi.getConfig.mockResolvedValueOnce(baseServerConfig);
    const configListener = vi.fn();
    const providersListener = vi.fn();
    const stop = startServerStateSync(serverApi);
    const unsubscribeConfig = onServerConfigUpdated(configListener);
    const unsubscribeProviders = onProvidersUpdated(providersListener);

    await waitFor(() => {
      expect(getServerConfig()).toEqual(baseServerConfig);
    });

    const nextProviders: ReadonlyArray<ServerProvider> = [
      {
        ...defaultProviders[0]!,
        status: "warning",
        checkedAt: "2026-01-02T00:00:00.000Z",
        message: "rate limited",
      },
    ];

    const nextKeybindings = [
      {
        command: "commandPalette.toggle",
        shortcut: {
          key: "p",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
    ] as const;

    emitServerConfigEvent({
      version: 1,
      type: "keybindingsUpdated",
      payload: {
        keybindings: nextKeybindings,
        issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
      },
    });
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

    await waitFor(() => {
      expect(getServerConfig()).toEqual({
        ...baseServerConfig,
        keybindings: nextKeybindings,
        issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
        providers: nextProviders,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          enableAssistantStreaming: true,
        },
      });
    });

    expect(providersListener).toHaveBeenLastCalledWith({ providers: nextProviders });
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

    unsubscribeProviders();
    unsubscribeConfig();
    stop();
  });
});
