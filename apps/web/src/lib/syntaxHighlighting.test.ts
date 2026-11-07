import { getFiletypeFromFileName } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { getSyntaxHighlighterPromise } from "./syntaxHighlighting";
import { CODE_THEME_OPTIONS, DIFF_THEME_NAMES } from "./diffRendering";

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
