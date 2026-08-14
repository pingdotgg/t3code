import { describe, expect, it } from "vite-plus/test";

import {
  applySyntaxThemeJson,
  extractVsCodeSyntax,
  parseThemeSyntax,
  SYNTAX_THEME_JSON_PLACEHOLDER,
} from "./themeSyntax";

const TOKEN_COLORS = [
  {
    scope: ["comment", "punctuation.definition.comment"],
    settings: { foreground: "#6272a4" },
  },
];

describe("theme syntax JSON", () => {
  it("extracts tokenColors from a VS Code snippet", () => {
    expect(
      extractVsCodeSyntax({
        tokenColors: TOKEN_COLORS,
        semanticTokenColors: { function: "#50fa7b" },
        colors: { "editor.foreground": "#f8f8f2", "editor.background": "#282a36" },
      }),
    ).toEqual({
      tokenColors: TOKEN_COLORS,
      semanticTokenColors: { function: "#50fa7b" },
      colors: { "editor.foreground": "#f8f8f2", "editor.background": "#282a36" },
    });
  });

  it("ignores extra workbench keys on a full color-theme.json", () => {
    const syntax = extractVsCodeSyntax({
      name: "Dracula",
      type: "dark",
      colors: {
        "editor.foreground": "#f8f8f2",
        "editor.background": "#282a36",
        "sideBar.background": "#21222c",
        "activityBar.background": "#191a21",
      },
      tokenColors: TOKEN_COLORS,
    });
    expect(syntax?.colors).toEqual({
      "editor.foreground": "#f8f8f2",
      "editor.background": "#282a36",
    });
    expect(syntax?.tokenColors).toEqual(TOKEN_COLORS);
  });

  it("applies a tokenColors object and a full VS Code file", () => {
    expect(applySyntaxThemeJson(JSON.stringify({ tokenColors: TOKEN_COLORS }))).toEqual({
      ok: true,
      syntax: { tokenColors: TOKEN_COLORS },
    });
    expect(
      applySyntaxThemeJson(
        JSON.stringify({
          name: "Dracula",
          type: "dark",
          colors: { "editor.background": "#282a36", "sideBar.background": "#21222c" },
          tokenColors: TOKEN_COLORS,
        }),
      ),
    ).toMatchObject({
      ok: true,
      syntax: {
        tokenColors: TOKEN_COLORS,
        colors: { "editor.background": "#282a36" },
      },
    });
  });

  it("treats empty JSON as no syntax and rejects invalid JSON", () => {
    expect(applySyntaxThemeJson("")).toEqual({ ok: true, syntax: undefined });
    expect(applySyntaxThemeJson("   ")).toEqual({ ok: true, syntax: undefined });
    expect(applySyntaxThemeJson("{")).toEqual({ ok: false, error: "That JSON is not valid." });
    expect(applySyntaxThemeJson(JSON.stringify({ colors: { canvas: "#111" } }))).toEqual({
      ok: false,
      error: 'Add a "tokenColors" array, or paste a VS Code color theme file.',
    });
  });

  it("parses per-appearance syntax and rejects unknown keys", () => {
    expect(
      parseThemeSyntax({
        dark: { tokenColors: TOKEN_COLORS },
      }),
    ).toEqual({ dark: { tokenColors: TOKEN_COLORS } });
    expect(() => parseThemeSyntax({ dim: { tokenColors: TOKEN_COLORS } })).toThrow(
      /light" or "dark/,
    );
    expect(JSON.parse(SYNTAX_THEME_JSON_PLACEHOLDER)).toHaveProperty("tokenColors");
  });
});
