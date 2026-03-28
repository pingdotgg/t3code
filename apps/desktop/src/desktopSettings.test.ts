import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { applyDesktopTitleBarModeSetting, readDesktopSettingsFromDisk } from "./desktopSettings";

function makeTempSettingsPath(): string {
  return Path.join(
    FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-desktop-settings-")),
    "settings.json",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readDesktopSettingsFromDisk", () => {
  it("returns an empty object when settings.json is invalid", () => {
    const settingsPath = makeTempSettingsPath();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    FS.writeFileSync(settingsPath, "{invalid", "utf8");

    expect(readDesktopSettingsFromDisk(settingsPath)).toEqual({});
    expect(consoleErrorSpy).toHaveBeenCalledOnce();

    FS.rmSync(Path.dirname(settingsPath), { recursive: true, force: true });
  });

  it("returns an empty object when settings.json is not a JSON object", () => {
    const settingsPath = makeTempSettingsPath();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    FS.writeFileSync(settingsPath, "[]", "utf8");

    expect(readDesktopSettingsFromDisk(settingsPath)).toEqual({});
    expect(consoleErrorSpy).toHaveBeenCalledOnce();

    FS.rmSync(Path.dirname(settingsPath), { recursive: true, force: true });
  });
});

describe("applyDesktopTitleBarModeSetting", () => {
  it("removes desktopTitleBarMode when the default mode is persisted", () => {
    expect(
      applyDesktopTitleBarModeSetting(
        { desktopTitleBarMode: "system", other: true },
        "t3code",
        "t3code",
      ),
    ).toEqual({ other: true });
  });

  it("writes desktopTitleBarMode when a non-default mode is persisted", () => {
    expect(applyDesktopTitleBarModeSetting({ other: true }, "system", "t3code")).toEqual({
      desktopTitleBarMode: "system",
      other: true,
    });
  });
});
