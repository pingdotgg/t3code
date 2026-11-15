import { describe, expect, it } from "vite-plus/test";

import {
  buildRestoreDeviceDefaultsPatch,
  getChangedDevicePreferenceLabels,
  isDevicePreferencesDefault,
} from "./device-defaults";

describe("device defaults", () => {
  it("reports no changes for empty preferences", () => {
    expect(getChangedDevicePreferenceLabels({})).toEqual([]);
    expect(isDevicePreferencesDefault({})).toBe(true);
  });

  it("detects a changed theme mode and text size", () => {
    const labels = getChangedDevicePreferenceLabels({ themeMode: "dark", baseFontSize: 20 });
    expect(labels).toEqual(["Color scheme", "Text size"]);
    expect(isDevicePreferencesDefault({ themeMode: "dark" })).toBe(false);
    expect(getChangedDevicePreferenceLabels({ markdownFontSize: 20 })).toEqual(["Text size"]);
  });

  it("detects custom terminal and code font sizes", () => {
    expect(getChangedDevicePreferenceLabels({ terminalFontSize: 14, codeFontSize: 12 })).toEqual([
      "Terminal font size",
      "Code font size",
    ]);
  });

  it("builds a patch that restores every device preference", () => {
    const patch = buildRestoreDeviceDefaultsPatch();
    expect(patch.themeMode).toBe("system");
    expect(patch.lightThemeId).toBe("t3-code");
    expect(patch.darkThemeId).toBe("t3-code");
    expect(patch.baseFontSize).toBe(16);
    expect(patch.mathRenderingEnabled).toBe(false);
    expect(patch.terminalFontSize).toBeNull();
    expect(patch.codeFontSize).toBeNull();
    expect(patch.codeWordBreak).toBe(false);
    expect(patch.projectGroupingMode).toBe("repository");
    expect(patch.workingShelfEnabled).toBe(true);
    expect(patch.useLastProjectForNewThreads).toBe(true);
    expect(patch.navigationTabOrder).toEqual([]);
    expect(patch.hiddenNavigationTabs).toEqual([]);
    expect(patch.followUpBehavior).toBe("steer");
    expect(patch.composerEnterBehavior).toBe("send");
    expect(patch.microphones).toEqual([]);
    expect(patch.androidNavigationStyle).toBeNull();
    expect("crashReportsEnabled" in patch).toBe(false);
  });

  it("restoring over saved preferences reads as default", () => {
    const current = { themeMode: "dark", androidNavigationStyle: "material" } as const;
    // Mirrors MobilePreferencesStore.update: next = { ...current, ...patch }.
    const saved = { ...current, ...buildRestoreDeviceDefaultsPatch() };
    expect(saved.androidNavigationStyle).toBeNull();
    expect(isDevicePreferencesDefault(saved)).toBe(true);
    expect(getChangedDevicePreferenceLabels(saved)).toEqual([]);
  });
});
