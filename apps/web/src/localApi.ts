import type { ContextMenuItem, LocalApi } from "@t3tools/contracts";

import { resetGitStatusStateForTests } from "./lib/gitStatusState";
import { resetSourceControlDiscoveryStateForTests } from "./lib/sourceControlDiscoveryState";
import { resetRequestLatencyStateForTests } from "./rpc/requestLatencyState";
import { resetServerStateForTests } from "./rpc/serverState";
import { resetWsConnectionStateForTests } from "./rpc/wsConnectionState";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
} from "./environments/runtime";
import {
  getPrimaryEnvironmentConnection,
  resetEnvironmentServiceForTests,
} from "./environments/runtime";
import { getPrimaryKnownEnvironment } from "./environments/primary";
import { type WsRpcClient } from "./rpc/wsRpcClient";
import { showContextMenuFallback } from "./contextMenuFallback";
import {
  readBrowserClientSettings,
  readBrowserSavedEnvironmentRegistry,
  readBrowserSavedEnvironmentSecret,
  removeBrowserSavedEnvironmentSecret,
  writeBrowserClientSettings,
  writeBrowserSavedEnvironmentRegistry,
  writeBrowserSavedEnvironmentSecret,
} from "./clientPersistenceStorage";

let cachedApi: LocalApi | undefined;

function unavailableLocalBackendError(): Error {
  return new Error("Local backend API is unavailable before a backend is paired.");
}

function createBrowserLocalApi(rpcClient?: WsRpcClient): LocalApi {
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
      openInEditor: (cwd, editor) =>
        rpcClient
          ? rpcClient.shell.openInEditor({ cwd, editor })
          : Promise.reject(unavailableLocalBackendError()),
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
          return window.desktopBridge.getClientSettings();
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
      getSavedEnvironmentRegistry: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getSavedEnvironmentRegistry();
        }
        return readBrowserSavedEnvironmentRegistry();
      },
      setSavedEnvironmentRegistry: async (records) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setSavedEnvironmentRegistry(records);
        }
        writeBrowserSavedEnvironmentRegistry(records);
      },
      getSavedEnvironmentSecret: async (environmentId) => {
        if (window.desktopBridge) {
          return window.desktopBridge.getSavedEnvironmentSecret(environmentId);
        }
        return readBrowserSavedEnvironmentSecret(environmentId);
      },
      setSavedEnvironmentSecret: async (environmentId, secret) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setSavedEnvironmentSecret(environmentId, secret);
        }
        return writeBrowserSavedEnvironmentSecret(environmentId, secret);
      },
      removeSavedEnvironmentSecret: async (environmentId) => {
        if (window.desktopBridge) {
          return window.desktopBridge.removeSavedEnvironmentSecret(environmentId);
        }
        removeBrowserSavedEnvironmentSecret(environmentId);
      },
    },
    server: {
      getConfig: () =>
        rpcClient ? rpcClient.server.getConfig() : Promise.reject(unavailableLocalBackendError()),
      refreshProviders: () =>
        rpcClient
          ? rpcClient.server.refreshProviders()
          : Promise.reject(unavailableLocalBackendError()),
      updateProvider: (input) =>
        rpcClient
          ? rpcClient.server.updateProvider(input)
          : Promise.reject(unavailableLocalBackendError()),
      upsertKeybinding: (input) =>
        rpcClient
          ? rpcClient.server.upsertKeybinding(input)
          : Promise.reject(unavailableLocalBackendError()),
      removeKeybinding: (input) =>
        rpcClient
          ? rpcClient.server.removeKeybinding(input)
          : Promise.reject(unavailableLocalBackendError()),
      getSettings: () =>
        rpcClient ? rpcClient.server.getSettings() : Promise.reject(unavailableLocalBackendError()),
      updateSettings: (patch) =>
        rpcClient
          ? rpcClient.server.updateSettings(patch)
          : Promise.reject(unavailableLocalBackendError()),
      discoverSourceControl: () =>
        rpcClient
          ? rpcClient.server.discoverSourceControl()
          : Promise.reject(unavailableLocalBackendError()),
    },
  };
}

export function createLocalApi(rpcClient: WsRpcClient): LocalApi {
  return createBrowserLocalApi(rpcClient);
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  if (window.nativeApi) {
    cachedApi = window.nativeApi;
    return cachedApi;
  }

  const primaryEnvironment = getPrimaryKnownEnvironment();
  cachedApi = primaryEnvironment
    ? createLocalApi(getPrimaryEnvironmentConnection().client)
    : createBrowserLocalApi();
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
  await resetEnvironmentServiceForTests();
  resetGitStatusStateForTests();
  resetSourceControlDiscoveryStateForTests();
  resetRequestLatencyStateForTests();
  resetSavedEnvironmentRegistryStoreForTests();
  resetSavedEnvironmentRuntimeStoreForTests();
  resetServerStateForTests();
  resetWsConnectionStateForTests();
}
