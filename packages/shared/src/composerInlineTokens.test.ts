import { describe, expect, it } from "vite-plus/test";

import {
  collectComposerInlineTokens,
  replaceComposerFileLinksWithBasenames,
} from "./composerInlineTokens.ts";

describe("collectComposerInlineTokens", () => {
  it("collects file links, mentions, and skills with source ranges", () => {
    const text = "Use $ui and inspect [Chat.tsx](src/Chat.tsx) with @AGENTS.md please";

    expect(collectComposerInlineTokens(text)).toEqual([
      {
        type: "skill",
        value: "ui",
        source: "$ui",
        start: 4,
        end: 7,
      },
      {
        type: "mention",
        value: "src/Chat.tsx",
        source: "[Chat.tsx](src/Chat.tsx)",
        start: 20,
        end: 44,
      },
      {
        type: "mention",
        value: "AGENTS.md",
        source: "@AGENTS.md",
        start: 50,
        end: 60,
      },
    ]);
  });

  it("does not convert incomplete trailing tokens", () => {
    expect(collectComposerInlineTokens("Use $ui")).toEqual([]);
    expect(collectComposerInlineTokens("Inspect @AGENTS.md")).toEqual([]);
  });

  it("keeps the delimiter after a token outside its source range", () => {
    const text = "Inspect [package.json](package.json) next";

    expect(collectComposerInlineTokens(text)).toEqual([
      {
        type: "mention",
        value: "package.json",
        source: "[package.json](package.json)",
        start: 8,
        end: 36,
      },
    ]);
    expect(text.slice(36)).toBe(" next");
  });

  it("preserves a confirmed pill when only its trailing delimiter is removed", () => {
    const withDelimiter = "[package.json](package.json) ";
    const confirmed = collectComposerInlineTokens(withDelimiter);

    expect(
      collectComposerInlineTokens(withDelimiter.trimEnd(), { preserveTrailingFrom: confirmed }),
    ).toEqual([
      {
        type: "mention",
        value: "package.json",
        source: "[package.json](package.json)",
        start: 0,
        end: 28,
      },
    ]);
  });

  it("does not preserve a pill after its source is edited", () => {
    const confirmed = collectComposerInlineTokens("[package.json](package.json) ");

    expect(
      collectComposerInlineTokens("[package.json](package-json)", {
        preserveTrailingFrom: confirmed,
      }),
    ).toEqual([]);
  });

  it("ignores normal web links", () => {
    expect(collectComposerInlineTokens("Read [docs](https://example.com) first")).toEqual([]);
  });

  it.each(["@expo/ui", "@jane/foo.js", "@scope/pkg/sub/path"])(
    "keeps scoped package reference %s as plain text",
    (reference) => {
      expect(collectComposerInlineTokens(`Install ${reference} next`)).toEqual([]);
    },
  );

  it("keeps scoped package references plain across incomplete input and IME whitespace", () => {
    expect(collectComposerInlineTokens("Install @expo/ui")).toEqual([]);
    expect(collectComposerInlineTokens("入力 @expo/ui　を追加")).toEqual([]);
  });

  it("keeps bare non-scoped file paths as mentions", () => {
    expect(collectComposerInlineTokens("Inspect @README.md next")).toEqual([
      {
        type: "mention",
        value: "README.md",
        source: "@README.md",
        start: 8,
        end: 18,
      },
    ]);
  });

  it("keeps canonical file links for scoped paths as mentions", () => {
    expect(collectComposerInlineTokens("Inspect [sub](@scope/pkg/sub) next")).toEqual([
      {
        type: "mention",
        value: "@scope/pkg/sub",
        source: "[sub](@scope/pkg/sub)",
        start: 8,
        end: 29,
      },
    ]);
  });

  it("allows ambiguous scoped paths through explicit quoted mentions", () => {
    expect(collectComposerInlineTokens('Inspect @"expo/ui" next')).toEqual([
      {
        type: "mention",
        value: "expo/ui",
        source: '@"expo/ui"',
        start: 8,
        end: 18,
      },
    ]);
  });
});

describe("replaceComposerFileLinksWithBasenames", () => {
  it("replaces a file link with its basename", () => {
    expect(replaceComposerFileLinksWithBasenames("Check [app.log](logs/app.log) for errors")).toBe(
      "Check app.log for errors",
    );
  });

  it("replaces absolute-path links from OS file drops", () => {
    expect(
      replaceComposerFileLinksWithBasenames(
        "[Rólegur kúreki.mp3](/Users/kr/R%C3%B3legur%20k%C3%BAreki.mp3)",
      ),
    ).toBe("Rólegur kúreki.mp3");
  });

  it("handles a trimmed prompt that ends with a link", () => {
    expect(replaceComposerFileLinksWithBasenames("Fix [a.ts](src/a.ts)")).toBe("Fix a.ts");
  });

  it("replaces multiple links and leaves surrounding text alone", () => {
    expect(replaceComposerFileLinksWithBasenames("[a.ts](src/a.ts) vs [b.ts](lib/b.ts) diff")).toBe(
      "a.ts vs b.ts diff",
    );
  });

  it("leaves @-mentions, skills, and plain text untouched", () => {
    expect(replaceComposerFileLinksWithBasenames("Use $ui with @src/Chat.tsx please")).toBe(
      "Use $ui with @src/Chat.tsx please",
    );
    expect(replaceComposerFileLinksWithBasenames("no tokens here")).toBe("no tokens here");
  });

  it("handles Windows separators in link destinations", () => {
    expect(replaceComposerFileLinksWithBasenames("[app.log](C:%5Crepo%5Capp.log) tail")).toBe(
      "app.log tail",
    );
  });
});
