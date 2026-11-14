import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopAssets from "../app/DesktopAssets.ts";

export const TITLEBAR_HEIGHT = 40;
// Match --workspace-topbar-height in apps/web/src/index.css; native macOS buttons stay 14 points at any zoom.
export const MACOS_WORKSPACE_TOPBAR_HEIGHT = 52;
export const MACOS_WINDOW_BUTTON_RADIUS = 7;

export function syncMacosWindowButtons(window: Electron.BrowserWindow): void {
  if (window.isDestroyed() || window.isFullScreen()) return;
  window.setWindowButtonPosition({
    x: 16,
    y: Math.round(
      (MACOS_WORKSPACE_TOPBAR_HEIGHT * window.webContents.getZoomFactor()) / 2 -
        MACOS_WINDOW_BUTTON_RADIUS,
    ),
  });
}

export const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
export const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
export const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";
export const MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 500;
export const DEVELOPMENT_LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;
export const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;
export const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
export const RENDERER_RECOVERY_WINDOW_MS = 60_000;
export const DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES = new Set([-2, -7, -9, -102, -105, -106, -118]);

export type WindowTitleBarOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

export function getIconOption(
  iconPaths: DesktopAssets.DesktopIconPaths,
  platform: NodeJS.Platform,
): { icon: string } | Record<string, never> {
  if (platform === "darwin") return {};
  const ext = platform === "win32" ? "ico" : "png";
  return Option.match(iconPaths[ext], {
    onNone: () => ({}),
    onSome: (icon) => ({ icon }),
  });
}

export function getInitialWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#000000" : "#ffffff";
}

export type DisplayBounds = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

export function windowFitsWithinDisplay(
  windowBounds: DesktopAppSettings.DesktopWindowBounds,
  displayBounds: DisplayBounds,
): boolean {
  return (
    windowBounds.x >= displayBounds.x &&
    windowBounds.y >= displayBounds.y &&
    windowBounds.x + windowBounds.width <= displayBounds.x + displayBounds.width &&
    windowBounds.y + windowBounds.height <= displayBounds.y + displayBounds.height
  );
}

export function windowBoundsEqual(
  left: DesktopAppSettings.DesktopWindowBounds,
  right: DesktopAppSettings.DesktopWindowBounds,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function resolveInitialMainWindowBounds(
  persistedBounds: DesktopAppSettings.DesktopWindowBounds | null,
  displays: readonly DisplayBounds[],
): DesktopAppSettings.DesktopWindowBounds | typeof DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE {
  if (
    persistedBounds !== null &&
    displays.some((display) => windowFitsWithinDisplay(persistedBounds, display))
  ) {
    return persistedBounds;
  }
  return DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE;
}

export function buildConnectingSplashDataUrl(shouldUseDarkColors: boolean): string {
  const background = getInitialWindowBackgroundColor(shouldUseDarkColors);
  const label = shouldUseDarkColors ? "#9ca3af" : "#6b7280";
  const accent = shouldUseDarkColors ? "#f8fafc" : "#1f2937";
  const track = shouldUseDarkColors ? "rgba(248,250,252,0.18)" : "rgba(31,41,55,0.18)";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;height:100%}body{background:${background};color:${label};font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;-webkit-user-select:none;user-select:none;-webkit-app-region:drag}.spinner{width:26px;height:26px;border:3px solid ${track};border-top-color:${accent};border-radius:50%;animation:spin .8s linear infinite}.label{font-size:13px}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="spinner"></div><div class="label">Connecting to WSL…</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function isSameOriginRendererNavigation(input: {
  readonly applicationUrl: string;
  readonly navigationUrl: string;
}): boolean {
  try {
    const applicationUrl = new URL(input.applicationUrl);
    const navigationUrl = new URL(input.navigationUrl);
    // Node serializes custom-scheme origins as "null", even for different hosts and schemes.
    return (
      applicationUrl.host !== "" &&
      navigationUrl.protocol === applicationUrl.protocol &&
      navigationUrl.host === applicationUrl.host
    );
  } catch {
    return false;
  }
}

export function isRetryableDevelopmentRendererLoadFailure(input: {
  readonly applicationUrl: string;
  readonly errorCode: number;
  readonly isMainFrame: boolean;
  readonly validatedUrl: string;
}): boolean {
  return (
    input.isMainFrame &&
    DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES.has(input.errorCode) &&
    isSameOriginRendererNavigation({
      applicationUrl: input.applicationUrl,
      navigationUrl: input.validatedUrl,
    })
  );
}

export function concealPendingQuitWindow(
  window: Pick<
    Electron.BrowserWindow,
    "isDestroyed" | "isFullScreen" | "setFullScreen" | "setOpacity"
  >,
): void {
  if (window.isDestroyed()) return;
  if (window.isFullScreen()) {
    window.setFullScreen(false);
  }
  // Linux lacks Electron window opacity; release-gated quits remain visible there.
  window.setOpacity(0);
}

export function getWindowTitleBarOptions(
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): WindowTitleBarOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: {
        x: 16,
        y: MACOS_WORKSPACE_TOPBAR_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS,
      },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

export function syncWindowAppearance(
  window: Electron.BrowserWindow,
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (window.isDestroyed()) {
      return;
    }

    window.setBackgroundColor(getInitialWindowBackgroundColor(shouldUseDarkColors));
    const { titleBarOverlay } = getWindowTitleBarOptions(shouldUseDarkColors, platform);
    if (typeof titleBarOverlay === "object") {
      window.setTitleBarOverlay(titleBarOverlay);
    }
  });
}

export type RevealSubscription = (listener: () => void) => void;

export function bindFirstRevealTrigger(
  subscribers: readonly RevealSubscription[],
  reveal: () => void,
): void {
  let revealed = false;
  const fire = () => {
    if (revealed) return;
    revealed = true;
    reveal();
  };
  for (const subscribe of subscribers) {
    subscribe(fire);
  }
}
