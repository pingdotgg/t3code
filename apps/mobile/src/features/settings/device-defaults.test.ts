import { describe, expect, it } from "vite-plus/test";

import {
  buildRestoreDeviceDefaultsPatch,
  getChangedDevicePreferenceLabels,
  isDevicePreferencesDefault,
  restoreDevicePreferencesTransform,
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
  });

  it("detects custom terminal and code font sizes", () => {
    expect(
      getChangedDevicePreferenceLabels({ terminalFontSize: 14, codeFontSize: 12 }),
    ).toEqual(["Terminal font size", "Code font size"]);
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
    expect(patch.planModeEnabled).toBe(false);
    expect(patch.crashReportsEnabled).toBe(true);
  });

  it("restored patch reads as default", () => {
    const patch = buildRestoreDeviceDefaultsPatch();
    expect(isDevicePreferencesDefault({ ...patch, androidNavigationStyle: undefined })).toBe(true);
    expect(
      getChangedDevicePreferenceLabels({ ...patch, androidNavigationStyle: undefined }),
    ).toEqual([]);
  });

  it("restore transform clears the navigation style key", () => {
    const restored = restoreDevicePreferencesTransform({
      themeMode: "dark",
      androidNavigationStyle: "material",
    });
    expect(restored.themeMode).toBe("system");
    expect("androidNavigationStyle" in restored).toBe(false);
    expect(isDevicePreferencesDefault({ ...restored, androidNavigationStyle: undefined })).toBe(
      true,
    );
  });
});
