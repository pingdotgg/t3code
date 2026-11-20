import { ClientSettingsSchema } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  clientProfileBaseKeys,
  clientProfileBaseName,
  clientProfileKeyName,
  isClientProfileBaseKey,
  type ClientProfileSurface,
} from "./keys.ts";

const D: ClientProfileSurface = { kind: "desktop", os: "mac" };
const B: ClientProfileSurface = { kind: "browser", os: "mac" };
const M: ClientProfileSurface = { kind: "mobile" };

describe("client profile keys", () => {
  it("maps per-OS keys to the device's OS and back", () => {
    expect(clientProfileKeyName("fontFamilyCode", D)).toBe("fontFamilyCode@mac");
    expect(clientProfileKeyName("chatWidth", B)).toBe("chatWidth");
    expect(clientProfileBaseName("fontFamilyCode@mac", B)).toBe("fontFamilyCode");
    expect(clientProfileBaseName("fontFamilyCode@windows", D)).toBeNull();
    expect(clientProfileBaseName("fontFamilyCode", D)).toBeNull();
    expect(clientProfileBaseName("chatWidth", B)).toBe("chatWidth");
    expect(clientProfileBaseName("customTheme.nightfall", B)).toBe("customTheme.nightfall");
    expect(clientProfileBaseName("customTheme.nightfall", M)).toBe("customTheme.nightfall");
    expect(clientProfileBaseName("themeLight", M)).toBe("themeLight");
    expect(clientProfileBaseName("chatWidth", M)).toBe("chatWidth");
    expect(clientProfileBaseName("snapShotShortcut@mac", B)).toBeNull();
    expect(clientProfileBaseName("unknownKey", D)).toBeNull();
  });

  it("limits each surface to its keys", () => {
    expect(clientProfileBaseKeys(M)).toHaveLength(9);
    expect(clientProfileBaseKeys(B)).toHaveLength(66);
    expect(clientProfileBaseKeys(D)).toHaveLength(84);
    expect(isClientProfileBaseKey("browserLinkTarget", D)).toBe(true);
    expect(isClientProfileBaseKey("browserLinkTarget", B)).toBe(false);
    expect(isClientProfileBaseKey("snapShotShortcut", D)).toBe(true);
    expect(isClientProfileBaseKey("snapShotShortcut", B)).toBe(false);
    for (const key of [
      "voiceMicrophone",
      "snapShotEnabled",
      "browserProfiles",
      "browserDefaultProfileId",
      "onboardingCompletedAt",
      "favorites",
      "providerModelPreferences",
    ]) {
      for (const surface of [M, B, D]) {
        expect(isClientProfileBaseKey(key, surface)).toBe(false);
      }
    }
    expect(isClientProfileBaseKey("customTheme.x", B)).toBe(true);
    expect(isClientProfileBaseKey("customTheme.", B)).toBe(false);
    expect(isClientProfileBaseKey("customTheme.x", M)).toBe(true);
    expect(isClientProfileBaseKey("customTheme.", M)).toBe(false);
  });

  it("accepts editor theme keys on the phone", () => {
    expect(isClientProfileBaseKey("customTheme.nord", M)).toBe(true);
    expect(clientProfileBaseName("customTheme.nord", M)).toBe("customTheme.nord");
  });

  it("every synced settings key is a ClientSettings field", () => {
    const notSettings = new Set([
      "themeMode",
      "themeLight",
      "themeDark",
      "typographyAdvanced",
      "lastEditor",
    ]);
    for (const key of clientProfileBaseKeys(D)) {
      if (notSettings.has(key)) continue;
      expect(Object.keys(ClientSettingsSchema.fields), key).toContain(key);
    }
  });
});
