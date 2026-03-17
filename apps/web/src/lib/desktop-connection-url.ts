import type { DesktopConnectionSettings } from "@t3tools/contracts";

export function buildDesktopConnectionUrlValue(settings: DesktopConnectionSettings): string {
  if (settings.mode !== "remote" || settings.remoteUrl.length === 0) {
    return "";
  }

  try {
    const parsed = new URL(settings.remoteUrl);
    if (settings.remoteAuthToken.length > 0) {
      parsed.searchParams.set("token", settings.remoteAuthToken);
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return settings.remoteUrl;
  }
}

export function resolveDesktopConnectionSettingsFromUrl(
  current: DesktopConnectionSettings,
  rawValue: string,
): DesktopConnectionSettings {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return {
      ...current,
      mode: "local",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Connection URL must be a valid http://, https://, ws://, or wss:// URL.");
  }

  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Connection URL must use http://, https://, ws://, or wss://.");
  }

  const token = parsed.searchParams.get("token")?.trim() ?? "";
  parsed.searchParams.delete("token");
  parsed.hash = "";

  return {
    ...current,
    mode: "remote",
    remoteUrl: parsed.toString(),
    remoteAuthToken: token,
  };
}
