import { type NativeApi, WS_CHANNELS, WS_METHODS, type WsWelcomePayload } from "@t3tools/contracts";

import { showContextMenuFallback } from "./contextMenuFallback";
import { WsTransport } from "./wsTransport";

let instance: { api: NativeApi; transport: WsTransport } | null = null;
const welcomeListeners = new Set<(payload: WsWelcomePayload) => void>();
let lastWelcome: WsWelcomePayload | null = null;

/**
 * Subscribe to the server welcome message. If a welcome was already received
 * before this call, the listener fires synchronously with the cached payload.
 * This avoids the race between WebSocket connect and React effect registration.
 */
export function onServerWelcome(listener: (payload: WsWelcomePayload) => void): () => void {
  welcomeListeners.add(listener);

  // Replay cached welcome for late subscribers
  if (lastWelcome) {
    try {
      listener(lastWelcome);
    } catch {
      // Swallow listener errors
    }
  }

  return () => {
    welcomeListeners.delete(listener);
  };
}

export function createWsNativeApi(): NativeApi {
  if (instance) return instance.api;

  const transport = new WsTransport();

  // Listen for server welcome and forward to registered listeners.
  // Also cache it so late subscribers (React effects) get it immediately.
  transport.subscribe(WS_CHANNELS.serverWelcome, (data) => {
    const payload = data as WsWelcomePayload;
    lastWelcome = payload;
    for (const listener of welcomeListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });

  const api: NativeApi = {
    todos: {
      list: async () => [],
      add: async () => [],
      toggle: async () => [],
      remove: async () => [],
    },
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
      onEvent: (callback) =>
        transport.subscribe(WS_CHANNELS.terminalEvent, callback as (data: unknown) => void),
    },
    agent: {
      spawn: async () => "",
      kill: async () => {},
      write: async () => {},
      onOutput: () => () => {},
      onExit: () => () => {},
    },
    providers: {
      startSession: (input) => transport.request(WS_METHODS.providersStartSession, input),
      sendTurn: (input) => transport.request(WS_METHODS.providersSendTurn, input),
      interruptTurn: (input) => transport.request(WS_METHODS.providersInterruptTurn, input),
      respondToRequest: (input) => transport.request(WS_METHODS.providersRespondToRequest, input),
      stopSession: (input) => transport.request(WS_METHODS.providersStopSession, input),
      listSessions: () => transport.request(WS_METHODS.providersListSessions),
      onEvent: (callback) =>
        transport.subscribe(WS_CHANNELS.providerEvent, callback as (data: unknown) => void),
    },
    projects: {
      list: () => transport.request(WS_METHODS.projectsList),
      add: (input) => transport.request(WS_METHODS.projectsAdd, input),
      remove: (input) => transport.request(WS_METHODS.projectsRemove, input),
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

        const popup = window.open(url, "_blank", "noopener,noreferrer");
        if (!popup) {
          throw new Error("Unable to open link. Allow popups and try again.");
        }
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
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly { id: T; label: string }[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: () => transport.request(WS_METHODS.serverGetConfig),
    },
  };

  instance = { api, transport };
  return api;
}
