import {
  ORCHESTRATION_WS_METHODS,
  type ContextMenuItem,
  type NativeApi,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerConfigUpdatedPayload,
  type ServerLifecycleStreamEvent,
  WS_METHODS,
  type WsWelcomePayload,
} from "@t3tools/contracts";

import { showContextMenuFallback } from "./contextMenuFallback";
import { WsTransport } from "./wsTransport";

let instance: { api: NativeApi; transport: WsTransport } | null = null;
const welcomeListeners = new Set<(payload: WsWelcomePayload) => void>();
export type ServerConfigUpdateSource = ServerConfigStreamEvent["type"];

interface ServerConfigUpdatedNotification {
  readonly payload: ServerConfigUpdatedPayload;
  readonly source: ServerConfigUpdateSource;
}

const serverConfigUpdatedListeners = new Set<
  (payload: ServerConfigUpdatedPayload, source: ServerConfigUpdateSource) => void
>();
const pendingServerConfigResolvers = new Set<(config: ServerConfig) => void>();

let latestWelcomePayload: WsWelcomePayload | null = null;
let latestServerConfig: ServerConfig | null = null;
let latestServerConfigUpdated: ServerConfigUpdatedNotification | null = null;

function emitWelcome(payload: WsWelcomePayload) {
  latestWelcomePayload = payload;
  for (const listener of welcomeListeners) {
    try {
      listener(payload);
    } catch {
      // Swallow listener errors.
    }
  }
}

function resolveServerConfig(config: ServerConfig) {
  latestServerConfig = config;
  for (const resolve of pendingServerConfigResolvers) {
    resolve(config);
  }
  pendingServerConfigResolvers.clear();
}

function emitServerConfigUpdated(
  payload: ServerConfigUpdatedPayload,
  source: ServerConfigUpdateSource,
) {
  latestServerConfigUpdated = { payload, source };
  for (const listener of serverConfigUpdatedListeners) {
    try {
      listener(payload, source);
    } catch {
      // Swallow listener errors.
    }
  }
}

function applyServerConfigEvent(event: ServerConfigStreamEvent) {
  switch (event.type) {
    case "snapshot": {
      resolveServerConfig(event.config);
      emitServerConfigUpdated(
        {
          issues: event.config.issues,
          providers: event.config.providers,
        },
        event.type,
      );
      return;
    }
    case "keybindingsUpdated": {
      if (!latestServerConfig) {
        return;
      }
      const nextConfig = {
        ...latestServerConfig,
        issues: event.payload.issues,
      } satisfies ServerConfig;
      resolveServerConfig(nextConfig);
      emitServerConfigUpdated(
        {
          issues: nextConfig.issues,
          providers: nextConfig.providers,
        },
        event.type,
      );
      return;
    }
    case "providerStatuses": {
      if (!latestServerConfig) {
        return;
      }
      const nextConfig = {
        ...latestServerConfig,
        providers: event.payload.providers,
      } satisfies ServerConfig;
      resolveServerConfig(nextConfig);
      emitServerConfigUpdated(
        {
          issues: nextConfig.issues,
          providers: nextConfig.providers,
        },
        event.type,
      );
      return;
    }
  }
}

function getServerConfigSnapshot(): Promise<ServerConfig> {
  if (latestServerConfig) {
    return Promise.resolve(latestServerConfig);
  }
  return new Promise<ServerConfig>((resolve) => {
    pendingServerConfigResolvers.add(resolve);
  });
}

/**
 * Subscribe to the server welcome message. If a welcome was already received
 * before this call, the listener fires synchronously with the cached payload.
 */
export function onServerWelcome(listener: (payload: WsWelcomePayload) => void): () => void {
  welcomeListeners.add(listener);

  if (latestWelcomePayload) {
    try {
      listener(latestWelcomePayload);
    } catch {
      // Swallow listener errors.
    }
  }

  return () => {
    welcomeListeners.delete(listener);
  };
}

/**
 * Subscribe to server config update events. Replays the latest update for
 * late subscribers to avoid missing config validation feedback.
 */
export function onServerConfigUpdated(
  listener: (payload: ServerConfigUpdatedPayload, source: ServerConfigUpdateSource) => void,
): () => void {
  serverConfigUpdatedListeners.add(listener);

  if (latestServerConfigUpdated) {
    try {
      listener(latestServerConfigUpdated.payload, latestServerConfigUpdated.source);
    } catch {
      // Swallow listener errors.
    }
  }

  return () => {
    serverConfigUpdatedListeners.delete(listener);
  };
}

export function createWsNativeApi(): NativeApi {
  if (instance) {
    return instance.api;
  }

  const transport = new WsTransport();

  transport.subscribe(
    WS_METHODS.subscribeServerLifecycle,
    {},
    (event: ServerLifecycleStreamEvent) => {
      if (event.type === "welcome") {
        emitWelcome(event.payload);
      }
    },
  );
  transport.subscribe(WS_METHODS.subscribeServerConfig, {}, (event: ServerConfigStreamEvent) => {
    applyServerConfigEvent(event);
  });

  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    terminal: {
      open: (input) => transport.request(WS_METHODS.terminalOpen, input),
      write: (input) => transport.request(WS_METHODS.terminalWrite, input),
      resize: (input) => transport.request(WS_METHODS.terminalResize, input),
      clear: (input) => transport.request(WS_METHODS.terminalClear, input),
      restart: (input) => transport.request(WS_METHODS.terminalRestart, input),
      close: (input) => transport.request(WS_METHODS.terminalClose, input),
      onEvent: (callback) => transport.subscribe(WS_METHODS.subscribeTerminalEvents, {}, callback),
    },
    projects: {
      searchEntries: (input) => transport.request(WS_METHODS.projectsSearchEntries, input),
      writeFile: (input) => transport.request(WS_METHODS.projectsWriteFile, input),
    },
    shell: {
      openInEditor: (cwd, editor) =>
        transport.request(WS_METHODS.shellOpenInEditor, { cwd, editor }),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    git: {
      pull: (input) => transport.request(WS_METHODS.gitPull, input),
      status: (input) => transport.request(WS_METHODS.gitStatus, input),
      runStackedAction: (input) => transport.request(WS_METHODS.gitRunStackedAction, input),
      listBranches: (input) => transport.request(WS_METHODS.gitListBranches, input),
      createWorktree: (input) => transport.request(WS_METHODS.gitCreateWorktree, input),
      removeWorktree: (input) => transport.request(WS_METHODS.gitRemoveWorktree, input),
      createBranch: (input) => transport.request(WS_METHODS.gitCreateBranch, input),
      checkout: (input) => transport.request(WS_METHODS.gitCheckout, input),
      init: (input) => transport.request(WS_METHODS.gitInit, input),
      resolvePullRequest: (input) => transport.request(WS_METHODS.gitResolvePullRequest, input),
      preparePullRequestThread: (input) =>
        transport.request(WS_METHODS.gitPreparePullRequestThread, input),
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: () => getServerConfigSnapshot(),
      upsertKeybinding: (input) => transport.request(WS_METHODS.serverUpsertKeybinding, input),
    },
    orchestration: {
      getSnapshot: () => transport.request(ORCHESTRATION_WS_METHODS.getSnapshot, {}),
      dispatchCommand: (command) =>
        transport.request(ORCHESTRATION_WS_METHODS.dispatchCommand, command),
      getTurnDiff: (input) => transport.request(ORCHESTRATION_WS_METHODS.getTurnDiff, input),
      getFullThreadDiff: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.getFullThreadDiff, input),
      replayEvents: (fromSequenceExclusive) =>
        transport.request(ORCHESTRATION_WS_METHODS.replayEvents, { fromSequenceExclusive }),
      onDomainEvent: (callback) =>
        transport.subscribe(WS_METHODS.subscribeOrchestrationDomainEvents, {}, callback),
    },
  };

  instance = { api, transport };
  return api;
}
