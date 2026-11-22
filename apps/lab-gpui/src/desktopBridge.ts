// The part of the desktop bridge the lab needs: the Database panel runs through databaseRun.
// The app calls other bridge methods unchecked once a bridge exists, so those are stubbed or
// answered as the browser would. Installed after module load, so isElectron stays false.
import type { DesktopBridge } from "@t3tools/contracts";

import { showContextMenuFallback } from "~/contextMenuFallback";
import { readBrowserClientSettings, writeBrowserClientSettings } from "~/clientPersistenceStorage";
import { labDatabaseRun } from "./database";

const unsubscribe = () => () => undefined;

export function installLabDesktopBridge() {
  let catalog: string | null = null;
  const bridge = {
    databaseRun: async (request) => labDatabaseRun(request),
    // Answered as without a bridge.
    getClientSettings: async () => readBrowserClientSettings(),
    setClientSettings: async (settings) => writeBrowserClientSettings(settings),
    showContextMenu: async (items, position) => showContextMenuFallback(items, position),
    openExternal: async (url) => window.open(url, "_blank", "noopener,noreferrer") !== null,
    openSystemSettings: async () => false,
    pickFolder: async () => null,
    // The primary HTTP layer asks for a bearer token (none: the fake fetch needs no auth) and the
    // connection storage keeps its catalog here; both are kept in memory.
    getLocalEnvironmentBearerToken: async () => "",
    getConnectionCatalog: async () => catalog,
    setConnectionCatalog: async (next) => {
      catalog = next;
      return true;
    },
    // Called without a check that the method exists.
    getClientPlatform: () => "darwin",
    getSystemLocale: () => null,
    getAppBranding: () => null,
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
    getWindowZoomFactor: () => 1,
    getWslState: async () => ({
      enabled: false,
      distro: null,
      available: false,
      wslOnly: false,
      distros: [],
      preflightError: null,
    }),
    revealWindow: async () => undefined,
    onMenuAction: unsubscribe,
    onQuitShortcut: unsubscribe,
    onNotificationBadgeClear: unsubscribe,
    onTrackpadScrollBegin: unsubscribe,
    onTrackpadScrollEnd: unsubscribe,
  } satisfies Partial<DesktopBridge>;
  Object.defineProperty(window, "desktopBridge", { value: bridge, configurable: true });
}
