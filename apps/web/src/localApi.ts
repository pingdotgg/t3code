import type { ContextMenuItem, DesktopRendererStateKey, LocalApi } from "@t3tools/contracts";

import { resetRequestLatencyStateForTests } from "./rpc/requestLatencyState";
import { showContextMenuFallback } from "./contextMenuFallback";
import {
  readBrowserClientSettings,
  removeBrowserClientSettings,
  writeBrowserClientSettings,
} from "./clientPersistenceStorage";
import {
  COMPOSER_PREFERENCES_STORAGE_KEY,
  readLegacyComposerPreferences,
} from "./composerPreferencesStorage";

const rendererStateStorageKeys = {
  "ui-state": "t3code:ui-state:v1",
  "composer-preferences": COMPOSER_PREFERENCES_STORAGE_KEY,
} as const satisfies Record<DesktopRendererStateKey, string>;

interface BrowserRendererStateCandidate {
  readonly raw: string;
  readonly cleanupKey: string | null;
}

function readValidBrowserRendererState(
  key: DesktopRendererStateKey,
): BrowserRendererStateCandidate | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(rendererStateStorageKeys[key]);
  } catch {
    return null;
  }
  if (raw === null) {
    if (key !== "composer-preferences") {
      return null;
    }
    const legacyPreferences = readLegacyComposerPreferences(window.localStorage);
    return legacyPreferences === null
      ? null
      : {
          raw: JSON.stringify(legacyPreferences),
          cleanupKey: null,
        };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? {
          raw,
          cleanupKey: rendererStateStorageKeys[key],
        }
      : null;
  } catch {
    return null;
  }
}

let cachedApi: LocalApi | undefined;

function unavailableLocalBackendError(): Error {
  return new Error("Local backend API is unavailable before a backend is paired.");
}

function createBrowserLocalApi(): LocalApi {
  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder(options);
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    shell: {
      openInEditor: () => Promise.reject(unavailableLocalBackendError()),
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
    persistence: {
      getClientSettings: async () => {
        if (window.desktopBridge) {
          const persistedSettings = await window.desktopBridge.getClientSettings();
          if (persistedSettings) {
            return persistedSettings;
          }

          const legacySettings = readBrowserClientSettings();
          if (!legacySettings) {
            return null;
          }
          await window.desktopBridge.setClientSettings(legacySettings);
          removeBrowserClientSettings();
          return legacySettings;
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
      getRendererState: async (key) => {
        if (window.desktopBridge) {
          const persistedState = await window.desktopBridge.getRendererState(key);
          if (persistedState !== null) {
            return persistedState;
          }

          const browserState = readValidBrowserRendererState(key);
          if (browserState === null) {
            return null;
          }
          await window.desktopBridge.setRendererState(key, browserState.raw);
          if (browserState.cleanupKey !== null) {
            try {
              window.localStorage.removeItem(browserState.cleanupKey);
            } catch {
              // The durable copy succeeded; blocked browser cleanup is harmless.
            }
          }
          return browserState.raw;
        }
        return readValidBrowserRendererState(key)?.raw ?? null;
      },
      setRendererState: async (key, value) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setRendererState(key, value);
        }
        const storageKey = rendererStateStorageKeys[key];
        if (value === null) {
          window.localStorage.removeItem(storageKey);
          return;
        }
        window.localStorage.setItem(storageKey, value);
      },
    },
    server: {
      getConfig: () => Promise.reject(unavailableLocalBackendError()),
      refreshProviders: () => Promise.reject(unavailableLocalBackendError()),
      updateProvider: () => Promise.reject(unavailableLocalBackendError()),
      upsertKeybinding: () => Promise.reject(unavailableLocalBackendError()),
      removeKeybinding: () => Promise.reject(unavailableLocalBackendError()),
      getSettings: () => Promise.reject(unavailableLocalBackendError()),
      updateSettings: () => Promise.reject(unavailableLocalBackendError()),
      discoverSourceControl: () => Promise.reject(unavailableLocalBackendError()),
      getTraceDiagnostics: () => Promise.reject(unavailableLocalBackendError()),
      getProcessDiagnostics: () => Promise.reject(unavailableLocalBackendError()),
      getProcessResourceHistory: () => Promise.reject(unavailableLocalBackendError()),
      signalProcess: () => Promise.reject(unavailableLocalBackendError()),
    },
  };
}

export function createLocalApi(): LocalApi {
  return createBrowserLocalApi();
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  if (window.nativeApi) {
    cachedApi = window.nativeApi;
    return cachedApi;
  }

  cachedApi = createBrowserLocalApi();
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}

export async function __resetLocalApiForTests() {
  cachedApi = undefined;
  const { __resetClientSettingsPersistenceForTests } = await import("./hooks/useSettings");
  __resetClientSettingsPersistenceForTests();
  resetRequestLatencyStateForTests();
}
