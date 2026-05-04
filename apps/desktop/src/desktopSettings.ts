import * as FS from "node:fs";
import * as Path from "node:path";
import type { DesktopServerExposureMode, DesktopUpdateChannel } from "@t3tools/contracts";

import { resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

export interface DesktopWindowSize {
  readonly width: number;
  readonly height: number;
}

export interface DesktopWindowDisplayState {
  readonly maximized: boolean;
  readonly fullscreen: boolean;
}

export interface DesktopSettings {
  readonly serverExposureMode: DesktopServerExposureMode;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  readonly updateChannel: DesktopUpdateChannel;
  readonly updateChannelConfiguredByUser: boolean;
  readonly windowSize?: DesktopWindowSize;
  readonly windowMaximized?: boolean;
  readonly windowFullscreen?: boolean;
}

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  serverExposureMode: "local-only",
  tailscaleServeEnabled: false,
  tailscaleServePort: DEFAULT_TAILSCALE_SERVE_PORT,
  updateChannel: "latest",
  updateChannelConfiguredByUser: false,
};

export function resolveDefaultDesktopSettings(appVersion: string): DesktopSettings {
  return {
    ...DEFAULT_DESKTOP_SETTINGS,
    updateChannel: resolveDefaultDesktopUpdateChannel(appVersion),
  };
}

export function setDesktopServerExposurePreference(
  settings: DesktopSettings,
  requestedMode: DesktopServerExposureMode,
): DesktopSettings {
  return settings.serverExposureMode === requestedMode
    ? settings
    : {
        ...settings,
        serverExposureMode: requestedMode,
      };
}

export function setDesktopTailscaleServePreference(
  settings: DesktopSettings,
  input: { readonly enabled: boolean; readonly port?: number },
): DesktopSettings {
  const port =
    input.port === undefined
      ? settings.tailscaleServePort
      : normalizeTailscaleServePort(input.port);
  return settings.tailscaleServeEnabled === input.enabled && settings.tailscaleServePort === port
    ? settings
    : {
        ...settings,
        tailscaleServeEnabled: input.enabled,
        tailscaleServePort: port,
      };
}

export function normalizeTailscaleServePort(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535
    ? value
    : DEFAULT_TAILSCALE_SERVE_PORT;
}

export function setDesktopUpdateChannelPreference(
  settings: DesktopSettings,
  requestedChannel: DesktopUpdateChannel,
): DesktopSettings {
  return {
    ...settings,
    updateChannel: requestedChannel,
    updateChannelConfiguredByUser: true,
  };
}

export function setDesktopWindowSize(
  settings: DesktopSettings,
  size: DesktopWindowSize,
): DesktopSettings {
  if (
    settings.windowSize !== undefined &&
    settings.windowSize.width === size.width &&
    settings.windowSize.height === size.height
  ) {
    return settings;
  }
  return {
    ...settings,
    windowSize: {
      width: size.width,
      height: size.height,
    },
  };
}

export function setDesktopWindowDisplayState(
  settings: DesktopSettings,
  displayState: DesktopWindowDisplayState,
): DesktopSettings {
  const currentMaximized = settings.windowMaximized ?? false;
  const currentFullscreen = settings.windowFullscreen ?? false;
  if (
    currentMaximized === displayState.maximized &&
    currentFullscreen === displayState.fullscreen
  ) {
    return settings;
  }
  return {
    ...settings,
    windowMaximized: displayState.maximized,
    windowFullscreen: displayState.fullscreen,
  };
}

function parseWindowSize(candidate: unknown): DesktopWindowSize | undefined {
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  const { width, height } = candidate as { readonly width?: unknown; readonly height?: unknown };
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  return { width, height };
}

function parseBooleanFlag(candidate: unknown): boolean | undefined {
  return typeof candidate === "boolean" ? candidate : undefined;
}

export function readDesktopSettings(settingsPath: string, appVersion: string): DesktopSettings {
  const defaultSettings = resolveDefaultDesktopSettings(appVersion);

  try {
    if (!FS.existsSync(settingsPath)) {
      return defaultSettings;
    }

    const raw = FS.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      readonly serverExposureMode?: unknown;
      readonly tailscaleServeEnabled?: unknown;
      readonly tailscaleServePort?: unknown;
      readonly updateChannel?: unknown;
      readonly updateChannelConfiguredByUser?: unknown;
      readonly windowSize?: unknown;
      readonly windowMaximized?: unknown;
      readonly windowFullscreen?: unknown;
    };
    const parsedUpdateChannel =
      parsed.updateChannel === "nightly" || parsed.updateChannel === "latest"
        ? parsed.updateChannel
        : null;
    const isLegacySettings = parsed.updateChannelConfiguredByUser === undefined;
    const updateChannelConfiguredByUser =
      parsed.updateChannelConfiguredByUser === true ||
      (isLegacySettings && parsedUpdateChannel === "nightly");
    const windowSize = parseWindowSize(parsed.windowSize);
    const windowMaximized = parseBooleanFlag(parsed.windowMaximized);
    const windowFullscreen = parseBooleanFlag(parsed.windowFullscreen);

    const resolvedSettings: DesktopSettings = {
      serverExposureMode:
        parsed.serverExposureMode === "network-accessible" ? "network-accessible" : "local-only",
      tailscaleServeEnabled: parsed.tailscaleServeEnabled === true,
      tailscaleServePort: normalizeTailscaleServePort(parsed.tailscaleServePort),
      updateChannel:
        updateChannelConfiguredByUser && parsedUpdateChannel !== null
          ? parsedUpdateChannel
          : defaultSettings.updateChannel,
      updateChannelConfiguredByUser,
      ...(windowSize === undefined ? {} : { windowSize }),
      ...(windowMaximized === undefined ? {} : { windowMaximized }),
      ...(windowFullscreen === undefined ? {} : { windowFullscreen }),
    };

    return resolvedSettings;
  } catch {
    return defaultSettings;
  }
}

export function writeDesktopSettings(settingsPath: string, settings: DesktopSettings): void {
  const directory = Path.dirname(settingsPath);
  const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  FS.mkdirSync(directory, { recursive: true });
  FS.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  FS.renameSync(tempPath, settingsPath);
}
