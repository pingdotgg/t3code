import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { setColorScheme, setTheme } = vi.hoisted(() => ({
  setColorScheme: vi.fn(),
  setTheme: vi.fn(),
}));

vi.mock("react-native", () => ({
  Appearance: { setColorScheme },
  useColorScheme: vi.fn(() => "light"),
}));

vi.mock("uniwind", () => ({
  Uniwind: {
    currentTheme: "light",
    setTheme,
    updateCSSVariables: vi.fn(),
  },
}));

vi.mock("../../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));

vi.mock("../../../state/synced-client-preferences", () => ({
  useUpdateAppearanceModePreference: vi.fn(),
  useUpdateThemePreference: vi.fn(),
}));

vi.mock("../../terminal/terminalUiState", () => ({
  cacheTerminalFontSize: vi.fn(),
}));

import { applyAppearanceModeToRuntimes } from "./AppearancePreferencesProvider";

describe("applyAppearanceModeToRuntimes", () => {
  beforeEach(() => {
    setColorScheme.mockClear();
    setTheme.mockClear();
  });

  it.each([
    { mode: "light" as const, runtimeTheme: "light", nativeScheme: "light" },
    { mode: "dark" as const, runtimeTheme: "dark", nativeScheme: "dark" },
    { mode: "system" as const, runtimeTheme: "system", nativeScheme: "unspecified" },
  ])("applies $mode to both styling runtimes", ({ mode, runtimeTheme, nativeScheme }) => {
    applyAppearanceModeToRuntimes(mode);

    expect(setTheme).toHaveBeenCalledWith(runtimeTheme);
    expect(setColorScheme).toHaveBeenCalledWith(nativeScheme);
  });
});
