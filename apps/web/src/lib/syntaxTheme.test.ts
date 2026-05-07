import { describe, expect, it } from "vitest";
import type { ResolvedColorTheme } from "@t3tools/contracts";
import { resolveCodeBlockThemeName, resolveSyntaxThemeName } from "./syntaxTheme";

function makeTheme(overrides: Partial<ResolvedColorTheme> = {}): ResolvedColorTheme {
  return {
    id: "vscode:github.github-vscode-theme:GitHub Dark Default",
    label: "GitHub Dark Default",
    source: "vscode",
    kind: "dark",
    colors: {
      "editor.background": "#0d1117",
      "editor.foreground": "#e6edf3",
    },
    tokenColors: [
      {
        scope: "keyword",
        settings: {
          foreground: "#ff7b72",
        },
      },
    ],
    appVariables: {
      "--background": "#0d1117",
      "--foreground": "#e6edf3",
    },
    ...overrides,
  };
}

describe("syntaxTheme", () => {
  it("falls back to built-in diff themes without an external theme", () => {
    expect(resolveSyntaxThemeName({ resolvedTheme: "dark", resolvedColorTheme: null })).toBe(
      "pierre-dark",
    );
    expect(resolveSyntaxThemeName({ resolvedTheme: "light", resolvedColorTheme: null })).toBe(
      "pierre-light",
    );
  });

  it("creates stable content-addressed custom syntax theme names", () => {
    const theme = makeTheme();
    expect(resolveSyntaxThemeName({ resolvedTheme: "dark", resolvedColorTheme: theme })).toBe(
      resolveSyntaxThemeName({ resolvedTheme: "dark", resolvedColorTheme: theme }),
    );
    expect(
      resolveSyntaxThemeName({
        resolvedTheme: "dark",
        resolvedColorTheme: makeTheme({
          tokenColors: [{ scope: "keyword", settings: { foreground: "#79c0ff" } }],
        }),
      }),
    ).not.toBe(resolveSyntaxThemeName({ resolvedTheme: "dark", resolvedColorTheme: theme }));
  });

  it("keeps the code block resolver as an alias of the shared syntax resolver", () => {
    const theme = makeTheme();
    expect(resolveCodeBlockThemeName({ resolvedTheme: "dark", resolvedColorTheme: theme })).toBe(
      resolveSyntaxThemeName({ resolvedTheme: "dark", resolvedColorTheme: theme }),
    );
  });

  it("handles bootstrap-cached external themes before full colors load", () => {
    const cachedTheme = {
      id: "vscode:github.github-vscode-theme:GitHub Dark Default",
      kind: "dark",
      appVariables: {
        "--background": "#0d1117",
        "--foreground": "#e6edf3",
      },
    } satisfies Partial<ResolvedColorTheme>;

    expect(
      resolveSyntaxThemeName({ resolvedTheme: "dark", resolvedColorTheme: cachedTheme }),
    ).toMatch(/^t3-syntax-/);
  });
});
