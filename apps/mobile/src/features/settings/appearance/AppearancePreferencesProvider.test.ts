import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  useColorScheme: vi.fn(() => "light"),
}));

vi.mock("uniwind", () => ({
  Uniwind: {
    currentTheme: "light",
    setTheme: vi.fn(),
    updateCSSVariables: vi.fn(),
  },
}));

vi.mock("../../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));

vi.mock("../../../state/synced-client-preferences", () => ({
  useUpdateAppearanceModePreference: vi.fn(),
  useUpdateThemeIdPreference: vi.fn(),
}));

vi.mock("../../terminal/terminalUiState", () => ({
  cacheTerminalFontSize: vi.fn(),
}));

import { parseMobileThemeFile } from "../../../lib/mobileThemeFile";
import { applyImportedThemeRemovalAtConfirmation } from "./AppearancePreferencesProvider";

describe("applyImportedThemeRemovalAtConfirmation", () => {
  const removalTarget = parseMobileThemeFile({
    version: 1,
    id: "removal-target",
    name: "Removal Target",
    appearance: "light",
    colors: { canvas: "#ffffff" },
  });
  const newerSelection = parseMobileThemeFile({
    version: 1,
    id: "newer-selection",
    name: "Newer Selection",
    appearance: "dark",
    colors: { canvas: "#000000" },
  });

  it("does not replace a newer per-half selection when an alert confirms", () => {
    const saveImportedThemes = vi.fn();
    const publishThemeId = vi.fn();

    applyImportedThemeRemovalAtConfirmation(removalTarget.id, {
      importedThemes: [removalTarget, newerSelection],
      themeIds: { light: "t3-code", dark: newerSelection.id },
      saveImportedThemes,
      publishThemeId,
    });

    expect(saveImportedThemes).toHaveBeenCalledWith([newerSelection]);
    expect(publishThemeId).not.toHaveBeenCalled();
  });

  it("resets only the half that still selects the removed theme", () => {
    const publishThemeId = vi.fn();

    applyImportedThemeRemovalAtConfirmation(removalTarget.id, {
      importedThemes: [removalTarget, newerSelection],
      themeIds: { light: removalTarget.id, dark: newerSelection.id },
      saveImportedThemes: vi.fn(),
      publishThemeId,
    });

    expect(publishThemeId).toHaveBeenCalledExactlyOnceWith("light", "t3-code");
  });
});
