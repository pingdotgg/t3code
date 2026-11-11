import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { customThemeNames, renderUniwindThemesCSS } from "./generate-uniwind-themes.mts";

describe("generate mobile Uniwind themes", () => {
  it("gives every theme the same variables and a fixed Clerk palette for its appearance", () => {
    const css =
      NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, "../global.css"), "utf8") +
      renderUniwindThemesCSS();
    const themes = new Map<string, Map<string, string>>(
      ["light", "dark", ...customThemeNames].map((name) => [name, new Map()]),
    );
    for (const [, name, body] of css.matchAll(/@variant ([\w-]+) \{([^}]+)\}/gu)) {
      const variables = themes.get(name!);
      for (const [, variable, value] of body!.matchAll(/(--[\w-]+):\s*([^;]+);/gu)) {
        variables?.set(variable!, value!.trim().toLowerCase());
      }
    }

    const lightVariables = themes.get("light")!;
    for (const [name, variables] of themes) {
      expect([...variables.keys()].sort(), name).toEqual([...lightVariables.keys()].sort());
      if (name === "dark") {
        for (const [role, color] of Object.entries({
          "--color-header": "#000000",
          "--color-thread-canvas": "#151515",
          "--color-sheet-solid": "#151515",
          "--color-card-alt": "#1d1d1d",
          "--color-grouped-card": "#1d1d1d",
          "--color-border": "#242424",
          "--color-primary": "#eeeeee",
          "--color-primary-foreground": "#111111",
        })) {
          expect(variables.get(role), role).toBe(color);
        }
      }
      if (name === "light") {
        expect(variables.get("--color-primary")).toBe("#111111");
        expect(variables.get("--color-primary-foreground")).toBe("#ffffff");
      }
      const isDark = name === "dark" || name.endsWith("-dark");
      expect(
        Object.fromEntries(
          [...variables].filter(([variable]) => variable.startsWith("--color-clerk-")),
        ),
        name,
      ).toEqual({
        "--color-clerk-page": isDark ? "#0a0a0a" : "#fcfcfc",
        "--color-clerk-foreground": isDark ? "#f5f5f5" : "#272727",
        "--color-clerk-foreground-muted": isDark ? "#818181" : "#727272",
        "--color-clerk-border": isDark ? "#191919" : "#e4e4e4",
        "--color-clerk-danger": isDark ? "#ff6467" : "#c10007",
      });
    }
  });
});
