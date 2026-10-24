import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mergeDeviceSettings,
  parseDeviceSettingsFile,
  pickDeviceSettings,
  serializeDeviceSettingsFile,
  type DeviceAppearance,
  type DeviceSettingsSnapshot,
} from "./deviceSettingsFile";

const KNOWN_THEMES = new Set(["system", "light", "dark", "nightfall"]);
const isKnownTheme = (themeId: string) => KNOWN_THEMES.has(themeId);

const DEFAULT_APPEARANCE: DeviceAppearance = {
  theme: "system",
  appearanceMode: "system",
  themeHalves: { light: null, dark: null },
  advancedTypography: false,
};

const defaults: DeviceSettingsSnapshot = {
  settings: pickDeviceSettings(DEFAULT_CLIENT_SETTINGS),
  appearance: DEFAULT_APPEARANCE,
};

describe("serializeDeviceSettingsFile", () => {
  it("writes every device setting and appearance value, and no machine settings", () => {
    const file = JSON.parse(
      serializeDeviceSettingsFile({
        settings: { ...DEFAULT_CLIENT_SETTINGS, onboardingCompletedAt: "2026-10-01T00:00:00.000Z" },
        appearance: DEFAULT_APPEARANCE,
      }),
    ) as Record<string, unknown>;

    expect(Object.keys(file)).toHaveLength(61 + 4);
    expect(file).not.toHaveProperty("onboardingCompletedAt");
    expect(file).toMatchObject({
      chatWidth: DEFAULT_CLIENT_SETTINGS.chatWidth,
      theme: "system",
      themeHalves: { light: null, dark: null },
      advancedTypography: false,
    });
  });
});

describe("parseDeviceSettingsFile", () => {
  it("reproduces the exported device, and leaves what a partial file omits", () => {
    const source: DeviceSettingsSnapshot = {
      settings: pickDeviceSettings({
        ...DEFAULT_CLIENT_SETTINGS,
        chatWidth: "wide",
        sendShortcut: "mod-enter",
      }),
      appearance: {
        theme: "nightfall",
        appearanceMode: "dark",
        themeHalves: { light: "light", dark: "nightfall" },
        advancedTypography: true,
      },
    };
    const file: unknown = JSON.parse(
      serializeDeviceSettingsFile({
        settings: { ...DEFAULT_CLIENT_SETTINGS, ...source.settings },
        appearance: source.appearance,
      }),
    );

    const imported = parseDeviceSettingsFile(file, isKnownTheme);
    expect(imported.warnings).toEqual([]);
    expect(mergeDeviceSettings(defaults, imported)).toEqual(source);

    const partial = parseDeviceSettingsFile({ wordWrap: false }, isKnownTheme);
    expect(mergeDeviceSettings(source, partial)).toEqual({
      settings: { ...source.settings, wordWrap: false },
      appearance: source.appearance,
    });
  });

  it("keeps the current value and warns for invalid values and unknown keys", () => {
    const current: DeviceSettingsSnapshot = {
      settings: { ...defaults.settings, chatWidth: "wide" },
      appearance: { ...DEFAULT_APPEARANCE, theme: "dark" },
    };
    const imported = parseDeviceSettingsFile(
      {
        chatWidth: 42,
        wordWrap: false,
        onboardingCompletedAt: "2026-10-01T00:00:00.000Z",
        addedInALaterVersion: true,
        theme: "missing-theme",
        appearanceMode: "light",
      },
      isKnownTheme,
    );

    expect(imported.warnings).toEqual([
      "chatWidth: invalid value, kept the current one",
      "onboardingCompletedAt: not a device setting, ignored",
      "addedInALaterVersion: not a device setting, ignored",
      "theme: invalid value, kept the current one",
    ]);
    expect(mergeDeviceSettings(current, imported)).toEqual({
      settings: { ...current.settings, wordWrap: false },
      appearance: { ...current.appearance, appearanceMode: "light" },
    });
  });

  it("merges each half of the light and dark theme pair on its own", () => {
    const current: DeviceSettingsSnapshot = {
      ...defaults,
      appearance: { ...DEFAULT_APPEARANCE, themeHalves: { light: "light", dark: "nightfall" } },
    };

    const cleared = parseDeviceSettingsFile({ themeHalves: { dark: null } }, isKnownTheme);
    expect(mergeDeviceSettings(current, cleared).appearance.themeHalves).toEqual({
      light: "light",
      dark: null,
    });

    const mixed = parseDeviceSettingsFile(
      { themeHalves: { light: "missing-theme", dark: "dark" } },
      isKnownTheme,
    );
    expect(mixed.warnings).toEqual(["themeHalves.light: invalid value, kept the current one"]);
    expect(mergeDeviceSettings(current, mixed).appearance.themeHalves).toEqual({
      light: "light",
      dark: "dark",
    });
  });
});
