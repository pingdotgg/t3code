import { describe, expect, it } from "vite-plus/test";

import {
  canonicalThemeColor,
  parsePortableThemeFile,
  themeColorToHex,
  themeIdFromName,
} from "./themeFile.ts";

describe("portable ThemeFile v1", () => {
  it("canonicalizes every color surface once for all clients", () => {
    const theme = parsePortableThemeFile({
      version: 1,
      name: "Northern Lights",
      appearance: "dark",
      colors: {
        canvas: "#0f172a",
        accent: "color(display-p3 0.2 0.7 0.4 / 40%)",
      },
      variants: { light: { canvas: "aliceblue" } },
    });

    expect(theme.id).toBe("northern-lights");
    expect(theme.colors.canvas).toBe(canonicalThemeColor("#0f172a"));
    expect(theme.colors.accent).toMatch(/\/ 0\.4\)$/);
    expect(themeColorToHex(theme.colors.canvas ?? "")).toBe("#0f172a");
    expect(theme.variants?.light?.canvas).toBe(canonicalThemeColor("aliceblue"));
  });

  it("rejects invalid literals, unknown roles, and repeated base variants", () => {
    const base = {
      version: 1,
      name: "Northern Lights",
      appearance: "dark",
      colors: { canvas: "#0f172a" },
    } as const;

    expect(() => parsePortableThemeFile({ ...base, colors: { canvas: "var(--canvas)" } })).toThrow(
      "literal CSS color",
    );
    expect(() => parsePortableThemeFile({ ...base, colors: { madeUp: "red" } })).toThrow(
      "not a supported theme color role",
    );
    expect(() =>
      parsePortableThemeFile({ ...base, variants: { dark: { canvas: "black" } } }),
    ).toThrow("must not repeat the base appearance");
  });

  it("rejects explicit and derived reserved ids consistently", () => {
    expect(themeIdFromName("T3 Code")).toBe("t3-code");
    for (const input of [
      {
        version: 1,
        id: "t3-code",
        name: "Custom",
        appearance: "light",
        colors: { canvas: "red" },
      },
      {
        version: 1,
        name: "T3 Code",
        appearance: "light",
        colors: { canvas: "red" },
      },
    ]) {
      expect(() => parsePortableThemeFile(input)).toThrow("reserved");
    }
  });
});
