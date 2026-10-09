import type {
  ClientSettings,
  ConfirmDialogOptions,
  ContextMenuItem,
  LocalApi,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { requestConfirmDialog } from "./confirmDialog";
import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";
import { readBrowserClientSettings, writeBrowserClientSettings } from "./clientPersistenceStorage";

let cachedApi: LocalApi | undefined;
let cachedClientSettings: ClientSettings = DEFAULT_CLIENT_SETTINGS;

function createBrowserLocalApi(): LocalApi {
  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder(options);
      },
      confirm: async (message, options?: ConfirmDialogOptions) => {
        return requestConfirmDialog(message, options) ?? false;
      },
    },
    shell: {
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
      // Only the desktop shell can reach the OS; the web build (and older
      // desktop shells that predate this method) have nothing to open.
      openSystemSettings: async (pane) => {
        if (!window.desktopBridge?.openSystemSettings) {
          throw new Error("Unable to open System Settings.");
        }
        const opened = await window.desktopBridge.openSystemSettings(pane);
        if (!opened) {
          throw new Error("Unable to open System Settings.");
        }
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (!window.desktopBridge || !cachedClientSettings.nativeContextMenus) {
          return showContextMenuFallback(items, position);
        }
        return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
      },
      // Dismissing is a no-op when no DOM menu is open, so this stays
      // unconditional: a native menu closes itself, and a state change that
      // deselects the menu's target still clears the fallback.
      close: async () => {
        dismissContextMenu();
      },
    },
    persistence: {
      getClientSettings: async () => {
        const settings = window.desktopBridge
          ? await window.desktopBridge.getClientSettings()
          : readBrowserClientSettings();
        cachedClientSettings = settings ?? DEFAULT_CLIENT_SETTINGS;
        return settings;
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          await window.desktopBridge.setClientSettings(settings);
        } else {
          writeBrowserClientSettings(settings);
        }
        cachedClientSettings = settings;
      },
    },
  };
}

export function createLocalApi(): LocalApi {
  return createBrowserLocalApi();
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  cachedApi = createLocalApi();
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}
