import "culori/css";
import { formatHex, parse } from "culori/fn";
import { describe, expect, it } from "vite-plus/test";
import type { DesktopLocalThemeState } from "@t3tools/contracts";
import { applyDesktopThemeState } from "./desktopTheme";
import {
  getDesktopLocalTheme,
  getStandardThemeColors,
  getThemeColorsForMode,
} from "./themePalette";

const native: DesktopLocalThemeState = {
  appearance: "dark",
  accent: null,
  source: "native",
  filePath: null,
  status: "ready",
  theme: null,
};
describe("native desktop palettes", () => {
  it("uses standard T3 colors for both appearances when no accent is exposed", () => {
    applyDesktopThemeState(native);
    for (const appearance of ["light", "dark"] as const) {
      expect(getThemeColorsForMode(getDesktopLocalTheme(), appearance)).toEqual(
        getStandardThemeColors(appearance),
      );
    }
  });
  it("uses the native accent for actions without replacing app surfaces or error colors", () => {
    applyDesktopThemeState({ ...native, accent: "#0055aa" });
    for (const appearance of ["light", "dark"] as const) {
      const colors = getThemeColorsForMode(getDesktopLocalTheme(), appearance)!;
      const defaults = getStandardThemeColors(appearance);
      expect(formatHex(parse(colors.accent))).toBe("#0055aa");
      expect(formatHex(parse(colors.messageAction))).toBe("#0055aa");
      expect(colors.canvas).toBe(defaults.canvas);
      expect(colors.sidebar).toBe(defaults.sidebar);
      expect(colors.error).toBe(defaults.error);
      expect(colors.accentForeground).not.toBe(colors.accent);
    }
  });
});
