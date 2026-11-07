import { converter } from "culori/fn";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { applyThemePalette, getStandardPaintedThemeColors } from "./themePalette";

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

describe("stock semantic palette mapping", () => {
  it("maps resolved roles to CSS chip surfaces", () => {
    const root = document.documentElement;
    try {
      for (const appearance of ["light", "dark"] as const) {
        root.classList.toggle("dark", appearance === "dark");
        applyThemePalette(appearance, appearance);
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
            expect(
              Math.abs(
                (channel * (expected.alpha ?? 1) +
                  (canvas[index]! / 255) * (1 - (expected.alpha ?? 1))) *
                  255 -
                  painted[index]!,
              ),
              `${appearance} ${role}`,
            ).toBeLessThan(1.5);
          });
        }
      }
    } finally {
      root.classList.remove("dark");
    }
  });
});
