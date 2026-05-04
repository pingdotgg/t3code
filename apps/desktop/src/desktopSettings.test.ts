import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DESKTOP_SETTINGS,
  readDesktopSettings,
  resolveDefaultDesktopSettings,
  setDesktopServerExposurePreference,
  setDesktopTailscaleServePreference,
  setDesktopUpdateChannelPreference,
  setDesktopWindowDisplayState,
  setDesktopWindowSize,
  writeDesktopSettings,
} from "./desktopSettings.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeSettingsPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-desktop-settings-test-"));
  tempDirectories.push(directory);
  return path.join(directory, "desktop-settings.json");
}

describe("desktopSettings", () => {
  it("returns defaults when no settings file exists", () => {
    expect(readDesktopSettings(makeSettingsPath(), "0.0.17")).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });

  it("defaults packaged nightly builds to the nightly update channel", () => {
    expect(resolveDefaultDesktopSettings("0.0.17-nightly.20260415.1")).toEqual({
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "nightly",
      updateChannelConfiguredByUser: false,
    });
  });

  it("persists and reloads the configured server exposure mode", () => {
    const settingsPath = makeSettingsPath();

    writeDesktopSettings(settingsPath, {
      serverExposureMode: "network-accessible",
      tailscaleServeEnabled: true,
      tailscaleServePort: 8443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: true,
    });

    expect(readDesktopSettings(settingsPath, "0.0.17")).toEqual({
      serverExposureMode: "network-accessible",
      tailscaleServeEnabled: true,
      tailscaleServePort: 8443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: true,
    });
  });

  it("preserves the requested network-accessible preference across temporary fallback", () => {
    expect(
      setDesktopServerExposurePreference(
        {
          serverExposureMode: "local-only",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
        },
        "network-accessible",
      ),
    ).toEqual({
      serverExposureMode: "network-accessible",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
    });
  });

  it("persists the requested Tailscale Serve preference", () => {
    expect(
      setDesktopTailscaleServePreference(
        {
          serverExposureMode: "local-only",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
        },
        { enabled: true, port: 8443 },
      ),
    ).toEqual({
      serverExposureMode: "local-only",
      tailscaleServeEnabled: true,
      tailscaleServePort: 8443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
    });
  });

  it("preserves the configured Tailscale Serve port when no new port is requested", () => {
    expect(
      setDesktopTailscaleServePreference(
        {
          serverExposureMode: "local-only",
          tailscaleServeEnabled: false,
          tailscaleServePort: 8443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
        },
        { enabled: true },
      ),
    ).toEqual({
      serverExposureMode: "local-only",
      tailscaleServeEnabled: true,
      tailscaleServePort: 8443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
    });
  });

  it("persists the requested nightly update channel", () => {
    expect(
      setDesktopUpdateChannelPreference(
        {
          serverExposureMode: "local-only",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
        },
        "nightly",
      ),
    ).toEqual({
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "nightly",
      updateChannelConfiguredByUser: true,
    });
  });

  it("falls back to defaults when the settings file is malformed", () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(settingsPath, "{not-json", "utf8");

    expect(readDesktopSettings(settingsPath, "0.0.17")).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });

  it("falls back to the nightly channel for legacy nightly settings without an update track", () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify({ serverExposureMode: "local-only" }), "utf8");

    expect(readDesktopSettings(settingsPath, "0.0.17-nightly.20260415.1")).toEqual({
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "nightly",
      updateChannelConfiguredByUser: false,
    });
  });

  it("migrates legacy implicit stable settings to nightly when running a nightly build", () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        serverExposureMode: "local-only",
        updateChannel: "latest",
      }),
      "utf8",
    );

    expect(readDesktopSettings(settingsPath, "0.0.17-nightly.20260415.1")).toEqual({
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "nightly",
      updateChannelConfiguredByUser: false,
    });
  });

  it("preserves an explicit stable choice on nightly builds", () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        serverExposureMode: "local-only",
        updateChannel: "latest",
        updateChannelConfiguredByUser: true,
      }),
      "utf8",
    );

    expect(readDesktopSettings(settingsPath, "0.0.17-nightly.20260415.1")).toEqual({
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: true,
    });
  });

  it("round-trips a persisted window size", () => {
    const settingsPath = makeSettingsPath();

    writeDesktopSettings(settingsPath, {
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      windowSize: { width: 1440, height: 900 },
    });

    expect(readDesktopSettings(settingsPath, "0.0.17")).toEqual({
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      windowSize: { width: 1440, height: 900 },
    });
  });

  it("omits windowSize when settings were written without one", () => {
    const settingsPath = makeSettingsPath();

    writeDesktopSettings(settingsPath, {
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
    });

    const result = readDesktopSettings(settingsPath, "0.0.17");
    expect(result.windowSize).toBeUndefined();
  });

  it.each([
    { label: "not an object", value: "1200x800" },
    { label: "null", value: null },
    { label: "missing height", value: { width: 1200 } },
    { label: "non-numeric width", value: { width: "1200", height: 800 } },
    { label: "non-finite width", value: { width: Number.POSITIVE_INFINITY, height: 800 } },
    { label: "non-finite height", value: { width: 1200, height: Number.NaN } },
    { label: "negative width", value: { width: -1200, height: 800 } },
    { label: "zero height", value: { width: 1200, height: 0 } },
  ])("discards a malformed windowSize ($label)", ({ value }) => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        serverExposureMode: "local-only",
        updateChannel: "latest",
        updateChannelConfiguredByUser: false,
        windowSize: value,
      }),
      "utf8",
    );

    expect(readDesktopSettings(settingsPath, "0.0.17").windowSize).toBeUndefined();
  });

  it("adds a windowSize via setDesktopWindowSize", () => {
    expect(
      setDesktopWindowSize(
        {
          serverExposureMode: "local-only",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
        },
        { width: 1280, height: 820 },
      ),
    ).toEqual({
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      windowSize: { width: 1280, height: 820 },
    });
  });

  it("returns the same reference when the windowSize is unchanged", () => {
    const settings = {
      serverExposureMode: "local-only" as const,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "latest" as const,
      updateChannelConfiguredByUser: false,
      windowSize: { width: 1280, height: 820 },
    };
    expect(setDesktopWindowSize(settings, { width: 1280, height: 820 })).toBe(settings);
  });

  it("round-trips windowMaximized and windowFullscreen flags", () => {
    const settingsPath = makeSettingsPath();

    writeDesktopSettings(settingsPath, {
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      windowMaximized: true,
      windowFullscreen: false,
    });

    expect(readDesktopSettings(settingsPath, "0.0.17")).toEqual({
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      windowMaximized: true,
      windowFullscreen: false,
    });
  });

  it.each([
    { label: "string", value: "true" },
    { label: "number", value: 1 },
    { label: "null", value: null },
    { label: "object", value: {} },
  ])("discards a malformed windowMaximized ($label)", ({ value }) => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        serverExposureMode: "local-only",
        updateChannel: "latest",
        updateChannelConfiguredByUser: false,
        windowMaximized: value,
      }),
      "utf8",
    );

    const result = readDesktopSettings(settingsPath, "0.0.17");
    expect(result.windowMaximized).toBeUndefined();
  });

  it("adds window display state via setDesktopWindowDisplayState", () => {
    expect(
      setDesktopWindowDisplayState(
        {
          serverExposureMode: "local-only",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
        },
        { maximized: true, fullscreen: false },
      ),
    ).toEqual({
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      windowMaximized: true,
      windowFullscreen: false,
    });
  });

  it("returns the same reference when display state is unchanged", () => {
    const settings = {
      serverExposureMode: "local-only" as const,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "latest" as const,
      updateChannelConfiguredByUser: false,
      windowMaximized: true,
      windowFullscreen: false,
    };
    expect(setDesktopWindowDisplayState(settings, { maximized: true, fullscreen: false })).toBe(
      settings,
    );
  });

  it("treats undefined maximized/fullscreen as false when diffing", () => {
    const settings = {
      serverExposureMode: "local-only" as const,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: "latest" as const,
      updateChannelConfiguredByUser: false,
    };
    expect(setDesktopWindowDisplayState(settings, { maximized: false, fullscreen: false })).toBe(
      settings,
    );
  });

  it("falls back to the default Tailscale Serve port when the persisted port is invalid", () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        tailscaleServeEnabled: true,
        tailscaleServePort: 0,
      }),
      "utf8",
    );

    expect(readDesktopSettings(settingsPath, "0.0.17")).toEqual({
      serverExposureMode: "local-only",
      tailscaleServeEnabled: true,
      tailscaleServePort: 443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
    });
  });
});
