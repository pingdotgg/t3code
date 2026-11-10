import type {
  DesktopBridge,
  DesktopNotificationTarget,
  DesktopPreviewAnnotationVoiceEvent,
  DesktopThreadDeepLinkPayload,
  DesktopPreviewOpenLinkEvent,
  DesktopPreviewPointerEvent,
  DesktopPreviewRecordingInputEvent,
  DesktopPreviewTabState,
  DesktopSnapShotEvent,
} from "@t3tools/contracts";
import { exposeClerkBridge } from "@clerk/electron/preload";
import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";

import * as IpcChannels from "./ipc/channels.ts";
import { mergeLegacyLocalStorage } from "./legacyLocalStorageMerge.ts";

const SNAP_SHOT_EVENT_TYPES = new Set([
  "requested",
  "started",
  "ready",
  "failed",
  "shortcut-changed",
]);
function isSnapShotEvent(value: unknown): value is DesktopSnapShotEvent {
  if (typeof value !== "object" || value === null) return false;
  const { type, id } = value as { type?: unknown; id?: unknown };
  return (
    typeof type === "string" &&
    SNAP_SHOT_EVENT_TYPES.has(type) &&
    (id === undefined || typeof id === "string")
  );
}

exposeClerkBridge({ passkeys: true });

// Runs before any app script reads localStorage. See DesktopLegacyLocalStorage.
try {
  const legacyItems: unknown = ipcRenderer.sendSync(IpcChannels.TAKE_LEGACY_LOCAL_STORAGE_CHANNEL);
  if (typeof legacyItems === "object" && legacyItems !== null) {
    if (mergeLegacyLocalStorage(window.localStorage, legacyItems as Record<string, string>)) {
      void ipcRenderer.invoke(IpcChannels.COMPLETE_LEGACY_LOCAL_STORAGE_CHANNEL);
    }
  }
} catch {}

// oxlint-disable-next-line t3code/no-global-process-runtime -- Electron exposes the client platform in its sandboxed preload process.
const clientPlatform = process.platform;

const desktopNotificationActivationListeners = new Set<
  (target: DesktopNotificationTarget) => void
>();
let pendingDesktopNotificationActivation: DesktopNotificationTarget | null = null;

ipcRenderer.on(IpcChannels.DESKTOP_NOTIFICATION_ACTIVATED_CHANNEL, (_event, target: unknown) => {
  if (
    typeof target !== "object" ||
    target === null ||
    !("environmentId" in target) ||
    typeof target.environmentId !== "string" ||
    !("threadId" in target) ||
    typeof target.threadId !== "string"
  ) {
    return;
  }
  const activation = target as DesktopNotificationTarget;
  if (desktopNotificationActivationListeners.size === 0) {
    pendingDesktopNotificationActivation = activation;
    return;
  }
  for (const listener of desktopNotificationActivationListeners) {
    listener(activation);
  }
});
if (clientPlatform === "darwin" && typeof window !== "undefined") {
  // Native window buttons do not scale with Chromium zoom. Keep their reserved
  // space in native points, including when a zoomed page is reloaded.
  const syncWindowControlInset = () => {
    document.documentElement.style.setProperty(
      "--desktop-window-controls-inset",
      `${90 / webFrame.getZoomFactor()}px`,
    );
  };
  window.addEventListener("DOMContentLoaded", syncWindowControlInset, { once: true });
  window.addEventListener("resize", syncWindowControlInset);
}

const syncHtmlFullscreen = () => {
  const element = document.fullscreenElement;
  // A preview guest's fullscreen surfaces here as its <webview>, which stays inside the window.
  void ipcRenderer.invoke(
    IpcChannels.SYNC_HTML_FULLSCREEN_CHANNEL,
    element !== null && element.tagName !== "WEBVIEW",
  );
};
// A reload or renderer crash never reports the old document's exit, so each document reports its start.
syncHtmlFullscreen();
document.addEventListener("fullscreenchange", syncHtmlFullscreen);

function unwrapEnsureSshEnvironmentResult(result: unknown) {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    result.type === IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT
  ) {
    const message =
      "message" in result && typeof result.message === "string"
        ? result.message
        : "SSH authentication cancelled.";
    throw new Error(message);
  }
  return result as Awaited<ReturnType<DesktopBridge["ensureSshEnvironment"]>>;
}

contextBridge.exposeInMainWorld("desktopBridge", {
  getAppBranding: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_APP_BRANDING_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    return result as ReturnType<DesktopBridge["getAppBranding"]>;
  },
  getRelayTelemetryEnabled: () =>
    ipcRenderer.sendSync(IpcChannels.GET_RELAY_TELEMETRY_ENABLED_CHANNEL) === true,
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getClientPlatform: () => clientPlatform,
  setNotificationBadge: (badge) =>
    ipcRenderer.invoke(IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL, badge),
  onNotificationBadgeClear: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL, handler);
  },
  onTrackpadScrollBegin: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IpcChannels.TRACKPAD_SCROLL_BEGIN_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IpcChannels.TRACKPAD_SCROLL_BEGIN_CHANNEL, handler);
  },
  onTrackpadScrollEnd: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IpcChannels.TRACKPAD_SCROLL_END_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IpcChannels.TRACKPAD_SCROLL_END_CHANNEL, handler);
  },
  revealWindow: () => ipcRenderer.invoke(IpcChannels.REVEAL_WINDOW_CHANNEL),
  getSystemLocale: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_SYSTEM_LOCALE_CHANNEL);
    return typeof result === "string" ? result : null;
  },
  getPreferredSystemLanguages: () => {
    const result: unknown = ipcRenderer.sendSync(
      IpcChannels.GET_PREFERRED_SYSTEM_LANGUAGES_CHANNEL,
    );
    return Array.isArray(result) ? result.filter((tag) => typeof tag === "string") : [];
  },
  getLocalEnvironmentBootstraps: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL);
    if (!Array.isArray(result)) {
      return [];
    }
    return result as ReturnType<DesktopBridge["getLocalEnvironmentBootstraps"]>;
  },
  getLocalEnvironmentBearerToken: () =>
    ipcRenderer.invoke(IpcChannels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL),
  getLocalEnvironmentEnabled: () =>
    ipcRenderer.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL) !== false,
  setLocalEnvironmentEnabled: (enabled) =>
    ipcRenderer.invoke(IpcChannels.SET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL, enabled),
  getHostEnvironmentId: () => ipcRenderer.invoke(IpcChannels.GET_HOST_ENVIRONMENT_ID_CHANNEL),
  getClientSettings: () => ipcRenderer.invoke(IpcChannels.GET_CLIENT_SETTINGS_CHANNEL),
  setClientSettings: (settings) =>
    ipcRenderer.invoke(IpcChannels.SET_CLIENT_SETTINGS_CHANNEL, settings),
  requestSnapShotPermissions: (includeAccessibility) =>
    ipcRenderer.invoke(IpcChannels.REQUEST_SNAP_SHOT_PERMISSIONS_CHANNEL, includeAccessibility),
  getSnapShotState: () => ipcRenderer.invoke(IpcChannels.GET_SNAP_SHOT_STATE_CHANNEL),
  setupSnapShot: (action) => ipcRenderer.invoke(IpcChannels.SETUP_SNAP_SHOT_CHANNEL, action),
  previewSnapShotConfig: (request) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_SNAP_SHOT_CONFIG_CHANNEL, request),
  applySnapShotConfig: (id) => ipcRenderer.invoke(IpcChannels.APPLY_SNAP_SHOT_CONFIG_CHANNEL, id),
  checkSnapShotShortcut: (shortcut) =>
    ipcRenderer.invoke(IpcChannels.CHECK_SNAP_SHOT_SHORTCUT_CHANNEL, shortcut),
  setSnapShotShortcutSuppressed: (suppressed) =>
    ipcRenderer.invoke(IpcChannels.SET_SNAP_SHOT_SHORTCUT_SUPPRESSED_CHANNEL, suppressed),
  listPendingSnapShots: () => ipcRenderer.invoke(IpcChannels.LIST_PENDING_SNAP_SHOTS_CHANNEL),
  readSnapShot: (id) => ipcRenderer.invoke(IpcChannels.READ_SNAP_SHOT_CHANNEL, id),
  setSnapShotAnimationDestination: (destination) =>
    ipcRenderer.invoke(IpcChannels.SET_SNAP_SHOT_ANIMATION_DESTINATION_CHANNEL, destination),
  dismissSnapShotAnimation: (id) =>
    ipcRenderer.invoke(IpcChannels.DISMISS_SNAP_SHOT_ANIMATION_CHANNEL, id),
  acknowledgeSnapShot: (id) => ipcRenderer.invoke(IpcChannels.ACKNOWLEDGE_SNAP_SHOT_CHANNEL, id),
  getConnectionCatalog: () => ipcRenderer.invoke(IpcChannels.GET_CONNECTION_CATALOG_CHANNEL),
  setConnectionCatalog: (catalog) =>
    ipcRenderer.invoke(IpcChannels.SET_CONNECTION_CATALOG_CHANNEL, catalog),
  discoverSshHosts: () => ipcRenderer.invoke(IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL),
  resolveSshHost: (alias) => ipcRenderer.invoke(IpcChannels.RESOLVE_SSH_HOST_CHANNEL, alias),
  ensureSshEnvironment: async (target, options) =>
    unwrapEnsureSshEnvironmentResult(
      await ipcRenderer.invoke(IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL, {
        target,
        ...(options === undefined ? {} : { options }),
      }),
    ),
  disconnectSshEnvironment: (target) =>
    ipcRenderer.invoke(IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL, target),
  fetchSshEnvironmentDescriptor: (httpBaseUrl) =>
    ipcRenderer.invoke(IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL, { httpBaseUrl }),
  bootstrapSshBearerSession: (httpBaseUrl, credential) =>
    ipcRenderer.invoke(IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL, {
      httpBaseUrl,
      credential,
    }),
  fetchSshSessionState: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL, { httpBaseUrl, bearerToken }),
  onSshPasswordPrompt: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
      if (typeof request !== "object" || request === null) return;
      listener(request as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    };
  },
  resolveSshPasswordPrompt: (requestId, password) =>
    ipcRenderer.invoke(IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL, { requestId, password }),
  getServerExposureState: () => ipcRenderer.invoke(IpcChannels.GET_SERVER_EXPOSURE_STATE_CHANNEL),
  setServerExposureMode: (mode) =>
    ipcRenderer.invoke(IpcChannels.SET_SERVER_EXPOSURE_MODE_CHANNEL, mode),
  setTailscaleServeEnabled: (input) =>
    ipcRenderer.invoke(IpcChannels.SET_TAILSCALE_SERVE_ENABLED_CHANNEL, input),
  getAdvertisedEndpoints: () => ipcRenderer.invoke(IpcChannels.GET_ADVERTISED_ENDPOINTS_CHANNEL),
  getWslState: () => ipcRenderer.invoke(IpcChannels.GET_WSL_STATE_CHANNEL),
  setWslBackendEnabled: (enabled) =>
    ipcRenderer.invoke(IpcChannels.SET_WSL_BACKEND_ENABLED_CHANNEL, enabled),
  setWslDistro: (distro) => ipcRenderer.invoke(IpcChannels.SET_WSL_DISTRO_CHANNEL, distro),
  setWslOnly: (enabled) => ipcRenderer.invoke(IpcChannels.SET_WSL_ONLY_CHANNEL, enabled),
  pickFolder: (options) => ipcRenderer.invoke(IpcChannels.PICK_FOLDER_CHANNEL, options),
  pickProjectFavicon: (initialPath) =>
    ipcRenderer.invoke(IpcChannels.PICK_PROJECT_FAVICON_CHANNEL, initialPath),
  pickThemeFiles: () => ipcRenderer.invoke(IpcChannels.PICK_THEME_FILES_CHANNEL, undefined),
  setTheme: (theme) => ipcRenderer.invoke(IpcChannels.SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) =>
    ipcRenderer.invoke(IpcChannels.CONTEXT_MENU_CHANNEL, {
      items,
      ...(position === undefined ? {} : { position }),
    }),
  requestTerminalPermission: (terminal) =>
    ipcRenderer.invoke(IpcChannels.REQUEST_TERMINAL_PERMISSION_CHANNEL, terminal),
  openTerminal: (input) => ipcRenderer.invoke(IpcChannels.OPEN_TERMINAL_CHANNEL, input),
  receiveProviderAuthCallback: (url: string) =>
    ipcRenderer.invoke(IpcChannels.RECEIVE_PROVIDER_AUTH_CALLBACK_CHANNEL, url),
  cancelProviderAuthCallback: (url: string) =>
    ipcRenderer.invoke(IpcChannels.CANCEL_PROVIDER_AUTH_CALLBACK_CHANNEL, url),
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.OPEN_EXTERNAL_CHANNEL, url),
  readMedia: (url: string) => ipcRenderer.invoke(IpcChannels.READ_MEDIA_CHANNEL, url),
  checkSystemPermission: (pane: string) =>
    ipcRenderer.invoke(IpcChannels.CHECK_SYSTEM_PERMISSION_CHANNEL, pane),
  openSystemSettings: (pane: string) =>
    ipcRenderer.invoke(IpcChannels.OPEN_SYSTEM_SETTINGS_CHANNEL, pane),
  probeRemoteEditors: () => ipcRenderer.invoke(IpcChannels.PROBE_REMOTE_EDITORS_CHANNEL, undefined),
  setAppIcon: (input) => ipcRenderer.invoke(IpcChannels.SET_APP_ICON_CHANNEL, input),
  getComputerUsePermissions: () =>
    ipcRenderer.invoke(IpcChannels.GET_COMPUTER_USE_PERMISSIONS_CHANNEL, undefined),
  openComputerUsePrivacySettings: (pane) =>
    ipcRenderer.invoke(IpcChannels.OPEN_COMPUTER_USE_PRIVACY_SETTINGS_CHANNEL, pane),
  installChromeExtension: () =>
    ipcRenderer.invoke(IpcChannels.INSTALL_CHROME_EXTENSION_CHANNEL, undefined),
  getComputerHistoryStatus: () =>
    ipcRenderer.invoke(IpcChannels.GET_COMPUTER_HISTORY_STATUS_CHANNEL, undefined),
  getComputerHistoryTimeline: () =>
    ipcRenderer.invoke(IpcChannels.GET_COMPUTER_HISTORY_TIMELINE_CHANNEL, undefined),
  patchComputerHistorySettings: (patch) =>
    ipcRenderer.invoke(IpcChannels.PATCH_COMPUTER_HISTORY_SETTINGS_CHANNEL, patch),
  clearComputerHistory: (scope) =>
    ipcRenderer.invoke(IpcChannels.CLEAR_COMPUTER_HISTORY_CHANNEL, scope),
  revealComputerHistoryMemory: (path) =>
    ipcRenderer.invoke(IpcChannels.REVEAL_COMPUTER_HISTORY_MEMORY_CHANNEL, path),
  deleteComputerHistoryMemory: (path) =>
    ipcRenderer.invoke(IpcChannels.DELETE_COMPUTER_HISTORY_MEMORY_CHANNEL, path),
  pasteAsText: () => ipcRenderer.invoke(IpcChannels.PASTE_AS_TEXT_CHANNEL, undefined),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  onDeepLink: (listener) => {
    let active = true;
    let deliveredGeneration = -1;
    const parsePayload = (payload: unknown): DesktopThreadDeepLinkPayload | null => {
      if (typeof payload !== "object" || payload === null) return null;
      const { environmentId, threadId } = payload as {
        environmentId?: unknown;
        threadId?: unknown;
      };
      if (typeof environmentId !== "string" || typeof threadId !== "string") return null;
      return { environmentId, threadId };
    };
    const deliver = (payload: unknown, generation: unknown) => {
      if (!active) return;
      const parsed = parsePayload(payload);
      if (parsed !== null) {
        if (typeof generation === "number") {
          if (generation <= deliveredGeneration) return;
          deliveredGeneration = generation;
        }
        listener(parsed);
        if (typeof generation === "number") {
          void ipcRenderer
            .invoke(IpcChannels.DEEP_LINK_ACK_CHANNEL, generation)
            .catch(() => undefined);
        }
      }
    };
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      payload: unknown,
      generation: unknown,
    ) => {
      deliver(payload, generation);
    };

    ipcRenderer.on(IpcChannels.DEEP_LINK_CHANNEL, wrappedListener);
    // Handshake: registering tells the main process this renderer is ready
    // for pushes, and returns the link buffered while no renderer was
    // (cold start) — or null.
    void ipcRenderer
      .invoke(IpcChannels.DEEP_LINK_SUBSCRIBE_CHANNEL)
      .then((result) => {
        const response =
          typeof result === "object" && result !== null && "payload" in result
            ? (result as { payload?: unknown; generation?: unknown })
            : { payload: result, generation: null };
        // A reply that lands after teardown is left for the next subscriber:
        // main keeps the link until an active listener acknowledges it.
        if (active) {
          deliver(response.payload, response.generation);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      ipcRenderer.removeListener(IpcChannels.DEEP_LINK_CHANNEL, wrappedListener);
      // Enqueue cleanup before a replacement listener can subscribe. Waiting
      // for the old subscribe reply would unregister that replacement.
      void ipcRenderer.invoke(IpcChannels.DEEP_LINK_UNSUBSCRIBE_CHANNEL).catch(() => undefined);
    };
  },
  onSnapShotEvent: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, event: unknown) => {
      if (!isSnapShotEvent(event)) return;
      listener(event);
    };

    ipcRenderer.on(IpcChannels.SNAP_SHOT_EVENT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.SNAP_SHOT_EVENT_CHANNEL, wrappedListener);
    };
  },
  onQuitShortcut: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, hint: unknown) => {
      if (typeof hint !== "object" || hint === null || !("state" in hint)) return;
      if (hint.state === "up") {
        listener({ state: "up" });
        return;
      }
      if (
        hint.state === "down" &&
        "mode" in hint &&
        (hint.mode === "hold" || hint.mode === "double-click")
      ) {
        listener({ state: "down", mode: hint.mode });
      }
    };

    ipcRenderer.on(IpcChannels.QUIT_SHORTCUT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.QUIT_SHORTCUT_CHANNEL, wrappedListener);
    };
  },
  getWindowFullscreenState: () =>
    ipcRenderer.sendSync(IpcChannels.GET_WINDOW_FULLSCREEN_STATE_CHANNEL) === true,
  getWindowZoomFactor: () => webFrame.getZoomFactor(),
  onWindowFullscreenStateChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, fullscreen: unknown) => {
      if (typeof fullscreen !== "boolean") return;
      listener(fullscreen);
    };

    ipcRenderer.on(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(IpcChannels.UPDATE_GET_STATE_CHANNEL),
  setUpdateChannel: (channel, minimumVersion) =>
    ipcRenderer.invoke(IpcChannels.UPDATE_SET_CHANNEL_CHANNEL, { channel, minimumVersion }),
  checkForUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: (expectedVersion) =>
    ipcRenderer.invoke(IpcChannels.UPDATE_INSTALL_CHANNEL, expectedVersion),
  cliCommand: {
    getState: () => ipcRenderer.invoke(IpcChannels.CLI_COMMAND_GET_STATE_CHANNEL),
    install: () => ipcRenderer.invoke(IpcChannels.CLI_COMMAND_INSTALL_CHANNEL),
    uninstall: () => ipcRenderer.invoke(IpcChannels.CLI_COMMAND_UNINSTALL_CHANNEL),
    addToPath: () => ipcRenderer.invoke(IpcChannels.CLI_COMMAND_ADD_TO_PATH_CHANNEL),
  },
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  notifications: {
    show: (input) => ipcRenderer.invoke(IpcChannels.DESKTOP_NOTIFICATION_SHOW_CHANNEL, input),
    dismiss: (target) =>
      ipcRenderer.invoke(IpcChannels.DESKTOP_NOTIFICATION_DISMISS_CHANNEL, target),
    dismissAll: () => ipcRenderer.invoke(IpcChannels.DESKTOP_NOTIFICATION_DISMISS_ALL_CHANNEL),
    showTest: (input) =>
      ipcRenderer.invoke(IpcChannels.DESKTOP_NOTIFICATION_SHOW_TEST_CHANNEL, input),
    onActivated: (listener) => {
      desktopNotificationActivationListeners.add(listener);
      const pendingActivation = pendingDesktopNotificationActivation;
      pendingDesktopNotificationActivation = null;
      if (pendingActivation !== null) {
        listener(pendingActivation);
      }
      return () => {
        desktopNotificationActivationListeners.delete(listener);
      };
    },
  },
  webLinks: {
    setReady: (ready) => ipcRenderer.invoke(IpcChannels.WEB_LINK_READY_CHANNEL, ready),
    onOpen: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, url: unknown) => {
        if (typeof url === "string") listener(url);
      };
      ipcRenderer.on(IpcChannels.WEB_LINK_OPEN_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IpcChannels.WEB_LINK_OPEN_CHANNEL, wrappedListener);
      };
    },
  },
  appActivation: {
    setReady: (ready) =>
      ipcRenderer.invoke(IpcChannels.DESKTOP_APP_ACTIVATION_READY_CHANNEL, ready),
    complete: (response) =>
      ipcRenderer.invoke(IpcChannels.DESKTOP_APP_ACTIVATION_COMPLETE_CHANNEL, response),
    onRequest: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
        if (typeof request !== "object" || request === null) return;
        listener(request as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IpcChannels.DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(
          IpcChannels.DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL,
          wrappedListener,
        );
      };
    },
  },
  preview: {
    setForwardedShortcuts: (shortcuts) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_FORWARDED_SHORTCUTS_CHANNEL, shortcuts),
    createTab: (tabId, defaults) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CREATE_TAB_CHANNEL, {
        tabId,
        zoomFactor: defaults?.zoomFactor,
        serverTab: defaults?.serverTab,
        colorScheme: defaults?.colorScheme,
      }),
    closeTab: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL, { tabId }),
    registerWebview: (tabId, webContentsId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL, { tabId, webContentsId }),
    navigate: (tabId, url) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_NAVIGATE_CHANNEL, { tabId, url }),
    goBack: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_GO_BACK_CHANNEL, { tabId }),
    goForward: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_GO_FORWARD_CHANNEL, { tabId }),
    refresh: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_REFRESH_CHANNEL, { tabId }),
    zoomIn: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_ZOOM_IN_CHANNEL, { tabId }),
    zoomOut: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL, { tabId }),
    resetZoom: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL, { tabId }),
    setZoomFactor: (tabId, zoomFactor) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ZOOM_FACTOR_CHANNEL, { tabId, zoomFactor }),
    hardReload: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL, { tabId }),
    setColorScheme: (tabId, colorScheme) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL, { tabId, colorScheme }),
    setViewport: (tabId, input) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_VIEWPORT_CHANNEL, {
        tabId,
        ...input,
      }),
    setAudioMuted: (tabId, audioMuted) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL, { tabId, audioMuted }),
    setShown: (tabId, shown) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_SHOWN_CHANNEL, { tabId, shown }),
    openDevTools: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL, { tabId }),
    listBrowserImportSources: () => ipcRenderer.invoke(IpcChannels.PREVIEW_IMPORT_SOURCES_CHANNEL),
    importBrowserCookies: (input) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_IMPORT_COOKIES_CHANNEL, input),
    clearCookies: (environmentId, profileId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL, { environmentId, profileId }),
    clearCache: (environmentId, profileId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL, { environmentId, profileId }),
    getPreviewConfig: (environmentId, profileId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_GET_CONFIG_CHANNEL, { environmentId, profileId }),
    setAnnotationTheme: (theme) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL, { theme }),
    setAnnotationSendEnabled: (tabId, enabled) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ANNOTATION_SEND_ENABLED_CHANNEL, {
        tabId,
        enabled,
      }),
    annotationVoice: {
      onEvent: (listener) => {
        const onEvent = (_event: Electron.IpcRendererEvent, tabId: string, value: unknown) => {
          if (typeof tabId !== "string" || typeof value !== "object" || value === null) return;
          listener(tabId, value as DesktopPreviewAnnotationVoiceEvent);
        };
        ipcRenderer.on(IpcChannels.PREVIEW_ANNOTATION_VOICE_EVENT_CHANNEL, onEvent);
        return () => ipcRenderer.off(IpcChannels.PREVIEW_ANNOTATION_VOICE_EVENT_CHANNEL, onEvent);
      },
      update: (state) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_ANNOTATION_VOICE_STATE_CHANNEL, state),
    },
    pickElement: (tabId, voice) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL, { tabId, voice }),
    cancelPickElement: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL, { tabId }),
    captureScreenshot: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL, { tabId }),
    revealArtifact: (path) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL, { path }),
    copyArtifactToClipboard: (path) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_COPY_ARTIFACT_CHANNEL, { path }),
    pictureInPicture: {
      open: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL, { tabId }),
      close: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL, { tabId }),
    },
    recording: {
      onInput: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, event: unknown) => {
          if (typeof event !== "object" || event === null) return;
          listener(event as DesktopPreviewRecordingInputEvent);
        };
        ipcRenderer.on(IpcChannels.PREVIEW_RECORDING_INPUT_CHANNEL, wrappedListener);
        return () =>
          ipcRenderer.removeListener(IpcChannels.PREVIEW_RECORDING_INPUT_CHANNEL, wrappedListener);
      },
      startScreencast: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_START_CHANNEL, { tabId }),
      stopScreencast: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL, { tabId }),
      save: (tabId, mimeType, data) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL, {
          tabId,
          mimeType,
          data,
        }),
    },
    onStateChange: (listener) => {
      const wrappedListener = (
        _event: Electron.IpcRendererEvent,
        tabId: unknown,
        state: unknown,
      ) => {
        if (typeof tabId !== "string" || typeof state !== "object" || state === null) return;
        listener(tabId, state as DesktopPreviewTabState);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrappedListener);
    },
    onPointerEvent: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, pointerEvent: unknown) => {
        if (typeof pointerEvent !== "object" || pointerEvent === null) return;
        listener(pointerEvent as DesktopPreviewPointerEvent);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, wrappedListener);
    },
    onOpenLink: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, linkEvent: unknown) => {
        if (typeof linkEvent !== "object" || linkEvent === null) return;
        listener(linkEvent as DesktopPreviewOpenLinkEvent);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_OPEN_LINK_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_OPEN_LINK_CHANNEL, wrappedListener);
    },
  },
} satisfies DesktopBridge);
