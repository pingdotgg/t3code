import { describe, expect, it } from "vitest";

import {
  DEFAULT_DESKTOP_CONNECTION_SETTINGS,
  normalizeDesktopConnectionSettings,
  resolveDesktopConnectionSettingsSnapshot,
} from "./desktopConnectionSettings";

describe("normalizeDesktopConnectionSettings", () => {
  it("defaults unknown values to local mode with empty strings", () => {
    expect(normalizeDesktopConnectionSettings(null)).toEqual(DEFAULT_DESKTOP_CONNECTION_SETTINGS);
  });

  it("trims persisted values", () => {
    expect(
      normalizeDesktopConnectionSettings({
        mode: "remote",
        remoteUrl: "  https://chat.example.com  ",
        authToken: "  secret  ",
      }),
    ).toEqual({
      mode: "remote",
      remoteUrl: "https://chat.example.com",
      authToken: "secret",
    });
  });
});

describe("resolveDesktopConnectionSettingsSnapshot", () => {
  it("treats the default local config as an implicit default", () => {
    expect(
      resolveDesktopConnectionSettingsSnapshot({
        saved: DEFAULT_DESKTOP_CONNECTION_SETTINGS,
        savedExists: false,
        environmentOverride: null,
      }),
    ).toEqual({
      source: "default",
      effective: DEFAULT_DESKTOP_CONNECTION_SETTINGS,
      saved: DEFAULT_DESKTOP_CONNECTION_SETTINGS,
    });
  });

  it("prefers an environment override over saved settings", () => {
    expect(
      resolveDesktopConnectionSettingsSnapshot({
        saved: {
          mode: "local",
          remoteUrl: "",
          authToken: "",
        },
        savedExists: true,
        environmentOverride: {
          mode: "remote",
          remoteUrl: "https://chat.example.com",
          authToken: "secret",
        },
      }),
    ).toEqual({
      source: "environment",
      effective: {
        mode: "remote",
        remoteUrl: "https://chat.example.com",
        authToken: "secret",
      },
      saved: {
        mode: "local",
        remoteUrl: "",
        authToken: "",
      },
    });
  });
});
