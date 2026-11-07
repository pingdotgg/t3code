import { getFiletypeFromFileName } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { getSyntaxHighlighterPromise } from "./syntaxHighlighting";
import { parseVsCodeThemeFile } from "../vscodeThemeImport";
import {
  CODE_THEME_OPTIONS,
  DIFF_THEME_NAMES,
  IMPORTED_CODE_THEME_PREFIX,
  resolveDiffThemeNames,
} from "./diffRendering";

describe("dialect file types", () => {
  it.each([
    ["src/init.luau", "lua"],
    ["styles/page.xsl", "xml"],
    ["styles/page.xslt", "xml"],
  ])("%s highlights as %s", (path, language) => {
    expect(getFiletypeFromFileName(path)).toBe(language);
  });
});

it.each([
  "asm",
  "assembly",
  "s",
  ...["asm", "ASM", "s", "S", "nasm", "NASM"].map((ext) => `src/start.${ext}`),
])("highlights assembly in %s", async (hint) => {
  const language = hint.includes("/") ? getFiletypeFromFileName(hint) : hint;
  const highlighter = await getSyntaxHighlighterPromise(language, DIFF_THEME_NAMES);
  const code = "mov eax, 42 ; answer\nret";
  for (const theme of Object.values(DIFF_THEME_NAMES)) {
    const { tokens } = highlighter.codeToTokens(code, { lang: language, theme });
    expect(tokens.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(code);
    expect(new Set(tokens.flat().map((token) => token.color)).size).toBeGreaterThan(1);
  }
});

it.each(
  (["light", "dark"] as const).flatMap((appearance) =>
    CODE_THEME_OPTIONS[appearance].map((option) => [appearance, option.id] as const),
  ),
)("offers %s code theme %s from the Highlights catalog", async (appearance, theme) => {
  const highlighter = await getSyntaxHighlighterPromise("typescript", {
    ...DIFF_THEME_NAMES,
    [appearance]: theme,
  });
  const { tokens } = highlighter.codeToTokens("const answer: number = 42; // ok", {
    lang: "typescript",
    theme,
  });
  expect(highlighter.getTheme(theme).type).toBe(appearance);
  expect(new Set(tokens.flat().map((token) => token.color)).size).toBeGreaterThan(2);
});

it("highlights code in an imported theme's syntax colors and falls back once it is gone", async () => {
  const theme = parseVsCodeThemeFile({
    name: "Imported Night",
    type: "dark",
    colors: { "editor.background": "#101010", "editor.foreground": "#dddddd" },
    tokenColors: [
      { scope: "storage.type", settings: { foreground: "#ff00aa" } },
      { scope: "comment", settings: { foreground: "#00ff99", fontStyle: "italic" } },
    ],
  });
  const settings = {
    codeThemeLight: "",
    codeThemeDark: `${IMPORTED_CODE_THEME_PREFIX}${theme.id}`,
  };
  const themes = resolveDiffThemeNames(settings, [theme]);
  expect(themes.light).toBe(DIFF_THEME_NAMES.light);

  const highlighter = await getSyntaxHighlighterPromise("typescript", themes);
  const { tokens } = highlighter.codeToTokens("const answer = 42; // ok", {
    lang: "typescript",
    theme: themes.dark,
  });
  const colorOf = (content: string) =>
    tokens
      .flat()
      .find((token) => token.content.includes(content))
      ?.color?.toLowerCase();
  expect(colorOf("const")).toBe("#ff00aa");
  expect(colorOf("// ok")).toBe("#00ff99");
  expect(colorOf("answer")).toBe("#dddddd");

  expect(resolveDiffThemeNames(settings, [])).toEqual(DIFF_THEME_NAMES);
});
