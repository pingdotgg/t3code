import * as FS from "node:fs";
import * as Path from "node:path";

import type {
  DesktopConnectionMode,
  DesktopConnectionSettings,
  DesktopConnectionSettingsSnapshot,
  DesktopConnectionSettingsSource,
} from "@t3tools/contracts";

const DESKTOP_CONNECTION_SETTINGS_FILENAME = "desktop-connection.json";

export const DEFAULT_DESKTOP_CONNECTION_SETTINGS: DesktopConnectionSettings = {
  mode: "local",
  remoteUrl: "",
  authToken: "",
};

interface ReadDesktopConnectionSettingsResult {
  exists: boolean;
  settings: DesktopConnectionSettings;
}

function normalizeMode(value: unknown): DesktopConnectionMode {
  return value === "remote" ? "remote" : "local";
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeDesktopConnectionSettings(
  value: Partial<DesktopConnectionSettings> | null | undefined,
): DesktopConnectionSettings {
  return {
    mode: normalizeMode(value?.mode),
    remoteUrl: normalizeString(value?.remoteUrl),
    authToken: normalizeString(value?.authToken),
  };
}

export function resolveDesktopConnectionSettingsPath(stateDir: string): string {
  return Path.join(stateDir, DESKTOP_CONNECTION_SETTINGS_FILENAME);
}

export function readDesktopConnectionSettings(path: string): ReadDesktopConnectionSettingsResult {
  if (!FS.existsSync(path)) {
    return {
      exists: false,
      settings: DEFAULT_DESKTOP_CONNECTION_SETTINGS,
    };
  }

  try {
    const raw = FS.readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<DesktopConnectionSettings>;
    return {
      exists: true,
      settings: normalizeDesktopConnectionSettings(parsed),
    };
  } catch {
    return {
      exists: true,
      settings: DEFAULT_DESKTOP_CONNECTION_SETTINGS,
    };
  }
}

export function writeDesktopConnectionSettings(
  path: string,
  settings: DesktopConnectionSettings,
): DesktopConnectionSettings {
  const normalized = normalizeDesktopConnectionSettings(settings);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  FS.mkdirSync(Path.dirname(path), { recursive: true });
  FS.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  FS.renameSync(tempPath, path);
  return normalized;
}

export function resolveDesktopConnectionSettingsSnapshot(input: {
  saved: DesktopConnectionSettings;
  savedExists: boolean;
  environmentOverride: DesktopConnectionSettings | null;
}): DesktopConnectionSettingsSnapshot {
  let source: DesktopConnectionSettingsSource = "default";
  let effective = input.saved;

  if (input.environmentOverride) {
    source = "environment";
    effective = input.environmentOverride;
  } else if (input.savedExists || input.saved.mode === "remote") {
    source = "settings";
  }

  return {
    source,
    effective,
    saved: input.saved,
  };
}
