import { converter } from "culori/fn";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import {
  applyThemeColorPreview,
  applyThemePalette,
  getStandardPaintedThemeColors,
} from "./themePalette";

const toRgb = converter("rgb");

function paintedChannels(variable: string, canvas: readonly number[] = [0, 0, 0]): number[] {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${variable})`;
  document.body.append(probe);
  try {
    const color = toRgb(getComputedStyle(probe).backgroundColor)!;
    const alpha = color.alpha ?? 1;
    return [color.r, color.g, color.b].map(
      (channel, index) => (channel * alpha + (canvas[index]! / 255) * (1 - alpha)) * 255,
    );
  } finally {
    probe.remove();
  }
}

describe("standard painted theme colors", () => {
  it("clears optional ANSI overrides when a draft or theme omits them", () => {
    const colors = getStandardPaintedThemeColors("dark");
    const root = document.documentElement;
    const variable = "--app-theme-terminal-ansi-red";
    try {
      applyThemeColorPreview({ ...colors, terminalAnsiRed: "#123456" }, "dark");
      expect(getComputedStyle(root).getPropertyValue(variable)).toBe("#123456");
      applyThemeColorPreview(colors, "dark");
      expect(getComputedStyle(root).getPropertyValue(variable)).toBe("");
      applyThemeColorPreview({ ...colors, terminalAnsiRed: "#123456" }, "dark");
      applyThemePalette("grove", "dark");
      expect(getComputedStyle(root).getPropertyValue(variable)).toBe("");
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
    }
  });

  it("match the chip surfaces index.css paints", () => {
    const root = document.documentElement;
    try {
      for (const appearance of ["light", "dark"] as const) {
        root.classList.toggle("dark", appearance === "dark");
        const colors = getStandardPaintedThemeColors(appearance);
        const canvas = paintedChannels("--background");
        for (const [variable, role] of [
          ["--background", "canvas"],
          ["--card", "surface"],
          ["--surface-raised", "surfaceRaised"],
          ["--message-surface", "messageSurface"],
        ] as const) {
          const expected = toRgb(colors[role])!;
          const painted = paintedChannels(variable, canvas);
          [expected.r, expected.g, expected.b].forEach((channel, index) => {
            expect(Math.abs(channel * 255 - painted[index]!), `${appearance} ${role}`).toBeLessThan(
              1.5,
            );
          });
        }
      }
    } finally {
      root.classList.remove("dark");
    }
  });
});
