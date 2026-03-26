import * as FS from "node:fs";
import * as Path from "node:path";

import type { DesktopTitleBarMode } from "@t3tools/contracts";

export function readDesktopSettingsFromDisk(settingsFilePath: string): Record<string, unknown> {
  if (!FS.existsSync(settingsFilePath)) {
    return {};
  }

  try {
    const raw = FS.readFileSync(settingsFilePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("settings.json must contain a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    console.error("[desktop] failed to parse settings.json", error);
    return {};
  }
}

export function applyDesktopTitleBarModeSetting(
  settings: Record<string, unknown>,
  mode: DesktopTitleBarMode,
  defaultMode: DesktopTitleBarMode,
): Record<string, unknown> {
  const nextSettings = { ...settings };
  if (mode === defaultMode) {
    delete nextSettings.desktopTitleBarMode;
  } else {
    nextSettings.desktopTitleBarMode = mode;
  }
  return nextSettings;
}

export function writeDesktopSettingsToDisk(
  settingsFilePath: string,
  settings: Record<string, unknown>,
): void {
  FS.mkdirSync(Path.dirname(settingsFilePath), { recursive: true });

  const tempPath = `${settingsFilePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    FS.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    FS.renameSync(tempPath, settingsFilePath);
  } finally {
    FS.rmSync(tempPath, { force: true });
  }
}
