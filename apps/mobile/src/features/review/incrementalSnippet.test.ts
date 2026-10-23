import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import typescript from "@shikijs/langs/typescript";
import dark from "@shikijs/themes/github-dark-default";
import { describe, expect, it } from "vite-plus/test";

import { createIncrementalSnippet } from "./incrementalSnippet";
import { highlightCodeSnippet } from "./shikiReviewHighlighter";

const highlighter = await createHighlighterCore({
  langs: [typescript],
  themes: [dark],
  engine: createJavaScriptRegexEngine(),
});
const rendered = (lines: ReturnType<typeof highlighter.codeToTokensBase>) =>
  lines.map((line) => line.map(({ content, color, fontStyle }) => ({ content, color, fontStyle })));
const options = { lang: "typescript", theme: "github-dark-default" };

describe("incremental snippet highlighting", () => {
  it("matches full highlighting through partial lines, multiline syntax, edits and truncation", async () => {
    const highlight = createIncrementalSnippet(highlighter, options.lang, options.theme);
    const source = "/* comment\nstill comment */\nconst text = `first\nsecond ${42}`;\n";
    for (let end = 1; end <= source.length; end++) {
      const code = source.slice(0, end);
      expect(rendered(highlight.read(code) ?? (await highlight(code)))).toEqual(
        rendered(highlighter.codeToTokensBase(code, options)),
      );
    }
    for (const code of ['const other = "new";\n', "const other", source, source.slice(0, 20)]) {
      expect(rendered(highlight.read(code) ?? (await highlight(code)))).toEqual(
        rendered(highlighter.codeToTokensBase(code, options)),
      );
    }
  });

  it("carries grammar state across batches and overlapping updates", async () => {
    const highlight = createIncrementalSnippet(highlighter, options.lang, options.theme);
    const code = "/*\n" + "still a comment\n".repeat(410) + "*/\nconst value = 42;";
    const first = highlight(code);
    const next = highlight("const changed = true;\n");
    expect(rendered(await first)).toEqual(rendered(highlighter.codeToTokensBase(code, options)));
    expect(rendered(await next)).toEqual(
      rendered(highlighter.codeToTokensBase("const changed = true;\n", options)),
    );
    const last = 'const changed = true;\nconst tail = "ok";';
    expect(rendered(await highlight(last))).toEqual(
      rendered(highlighter.codeToTokensBase(last, options)),
    );
  });

  it("resets session on language, theme, CRLF, long-line and empty input changes", async () => {
    const session = {};
    const cases = [
      { code: "/* hello\nworld */", language: "ts", theme: "dark" as const },
      { code: "/* hello\nworld */\nconst n = 3;", language: "ts", theme: "light" as const },
      { code: "hello\nworld", language: "text", theme: "light" as const },
      { code: "const n = 2;\r\nconst m = 3;", language: "ts", theme: "dark" as const },
      { code: "a".repeat(1100), language: "ts", theme: "dark" as const },
      { code: "", language: "ts", theme: "dark" as const },
      { code: "const fresh = true;\n", language: "ts", theme: "dark" as const },
    ];
    for (const input of cases)
      expect(await highlightCodeSnippet({ ...input, session })).toEqual(
        await highlightCodeSnippet(input),
      );
  });
});
