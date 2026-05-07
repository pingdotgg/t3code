import { describe, expect, it } from "vitest";
import { mapVscodeColorsToAppVariables, normalizeThemeColors } from "./themeMapping.ts";

describe("themeMapping", () => {
  it("normalizes supported VS Code hex colors only", () => {
    expect(
      normalizeThemeColors({
        "editor.background": "#010203",
        "button.background": "#abc",
        ignored: "rgb(1, 2, 3)",
        missing: null,
      }),
    ).toEqual({
      "editor.background": "#010203",
      "button.background": "#abc",
    });
  });

  it("maps VS Code workbench colors to app variables", () => {
    const variables = mapVscodeColorsToAppVariables({
      kind: "dark",
      colors: {
        "editor.background": "#0d1117",
        "editor.foreground": "#e6edf3",
        "button.background": "#238636",
        "button.foreground": "#ffffff",
        "sideBar.background": "#010409",
        "terminal.ansiGreen": "#3fb950",
      },
    });

    expect(variables["--background"]).toBe("#0d1117");
    expect(variables["--foreground"]).toBe("#e6edf3");
    expect(variables["--primary"]).toBe("#238636");
    expect(variables["--sidebar"]).toBe("#010409");
    expect(variables["--success"]).toBe("#3fb950");
  });
});
