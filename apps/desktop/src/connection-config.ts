import * as FS from "node:fs";
import * as Path from "node:path";

import type {
  DesktopConnectionInfo,
  DesktopConnectionMode,
  DesktopConnectionSettings,
} from "@t3tools/contracts";

export class DesktopConnectionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopConnectionConfigError";
  }
}

const CONNECTION_CONFIG_FILENAME = "desktop-connection.json";

export function getDefaultDesktopConnectionSettings(): DesktopConnectionSettings {
  return {
    mode: "local",
    remoteUrl: "",
    remoteAuthToken: "",
  };
}

function normalizeMode(value: unknown): DesktopConnectionMode {
  return value === "remote" ? "remote" : "local";
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function sanitizeDesktopConnectionSettings(value: unknown): DesktopConnectionSettings {
  if (!value || typeof value !== "object") {
    return getDefaultDesktopConnectionSettings();
  }

  const record = value as Record<string, unknown>;
  return {
    mode: normalizeMode(record.mode),
    remoteUrl: normalizeString(record.remoteUrl),
    remoteAuthToken: normalizeString(record.remoteAuthToken),
  };
}

export function validateDesktopConnectionSettings(
  input: DesktopConnectionSettings,
): DesktopConnectionSettings {
  const settings = sanitizeDesktopConnectionSettings(input);
  if (settings.mode === "local") {
    return settings;
  }

  if (settings.remoteUrl.length === 0) {
    throw new DesktopConnectionConfigError("Remote URL is required.");
  }

  let remoteUrl: URL;
  try {
    remoteUrl = new URL(settings.remoteUrl);
  } catch {
    throw new DesktopConnectionConfigError("Remote URL must be a valid http:// or https:// URL.");
  }

  if (remoteUrl.protocol !== "http:" && remoteUrl.protocol !== "https:") {
    throw new DesktopConnectionConfigError("Remote URL must use http:// or https://.");
  }
  if (!remoteUrl.hostname) {
    throw new DesktopConnectionConfigError("Remote URL must include a host.");
  }

  return {
    ...settings,
    remoteUrl: remoteUrl.toString(),
  };
}

export function buildDesktopRemoteWsUrl(settings: DesktopConnectionSettings): string {
  const validated = validateDesktopConnectionSettings(settings);
  if (validated.mode !== "remote") {
    throw new DesktopConnectionConfigError("Remote WebSocket URL is only available in remote mode.");
  }

  const remoteUrl = new URL(validated.remoteUrl);
  remoteUrl.protocol = remoteUrl.protocol === "https:" ? "wss:" : "ws:";
  remoteUrl.pathname = "/";
  remoteUrl.search = "";
  if (validated.remoteAuthToken.length > 0) {
    remoteUrl.searchParams.set("token", validated.remoteAuthToken);
  }
  remoteUrl.hash = "";
  return remoteUrl.toString();
}

export function getDesktopConnectionInfo(
  settings: DesktopConnectionSettings,
): DesktopConnectionInfo {
  return { mode: settings.mode };
}

export function resolveDesktopConnectionConfigPath(userDataPath: string): string {
  return Path.join(userDataPath, CONNECTION_CONFIG_FILENAME);
}

export function readDesktopConnectionSettings(configPath: string): DesktopConnectionSettings {
  try {
    const raw = FS.readFileSync(configPath, "utf8");
    return sanitizeDesktopConnectionSettings(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return getDefaultDesktopConnectionSettings();
    }
    throw error;
  }
}

export function writeDesktopConnectionSettings(
  configPath: string,
  input: DesktopConnectionSettings,
): DesktopConnectionSettings {
  const settings = validateDesktopConnectionSettings(input);
  FS.mkdirSync(Path.dirname(configPath), { recursive: true });
  FS.writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return settings;
}
