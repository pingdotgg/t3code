import { converter } from "culori/fn";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { applyAppearanceContrast } from "./appearanceContrast";
import {
  applyThemeColorPreview,
  applyThemePalette,
  getStandardPaintedThemeColors,
} from "./themePalette";
import { parseVsCodeThemeFile } from "./vscodeThemeImport";

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

describe("imported user message colors", () => {
  it.each([
    { type: "light", canvas: "#ffffff", surface: "#000000", contrast: 200, foreground: 1 },
    { type: "dark", canvas: "#000000", surface: "#ffffff", contrast: 200, foreground: 0 },
    { type: "light", canvas: "#ffffff", surface: "#565656", contrast: 100, foreground: 1 },
  ] as const)(
    "keeps prose, links, and footnotes readable on $surface in a $type theme at $contrast%",
    ({ type, canvas, surface, contrast, foreground }) => {
      const root = document.documentElement;
      const theme = parseVsCodeThemeFile({
        type,
        colors: {
          "editor.background": canvas,
          "chat.requestBubbleBackground": surface,
          descriptionForeground: surface,
        },
      });
      const bubble = document.createElement("div");
      bubble.className = "bg-message text-message-foreground chat-markdown user-message-markdown";
      bubble.innerHTML =
        '<p>Prose <a href="#sample">Link</a></p><section data-footnotes><ol><li><p>Footnote</p></li></ol></section>';
      document.body.append(bubble);
      try {
        applyThemeColorPreview(theme.colors, theme.appearance);
        applyAppearanceContrast(root, contrast);
        const paintedSurface = toRgb(getComputedStyle(bubble).backgroundColor)!;
        const expectedSurface = toRgb(surface)!;
        expect(paintedSurface.r).toBeCloseTo(expectedSurface.r);
        expect(paintedSurface.g).toBeCloseTo(expectedSurface.g);
        expect(paintedSurface.b).toBeCloseTo(expectedSurface.b);
        for (const element of bubble.querySelectorAll("p, a")) {
          const painted = toRgb(getComputedStyle(element).color)!;
          for (const channel of [painted.r, painted.g, painted.b]) {
            expect(channel, element.textContent ?? "").toBeCloseTo(foreground);
          }
        }
      } finally {
        bubble.remove();
        applyAppearanceContrast(root, 100);
        applyThemePalette("system", "light");
        root.classList.remove("dark");
      }
    },
  );
});
