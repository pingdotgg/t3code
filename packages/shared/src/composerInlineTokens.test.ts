import { describe, expect, it } from "vite-plus/test";

import { collectComposerInlineTokens } from "./composerInlineTokens.ts";

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

  it("collects skill names that begin with a digit", () => {
    expect(collectComposerInlineTokens("Use $2spec next")).toEqual([
      {
        type: "skill",
        value: "2spec",
        source: "$2spec",
        start: 4,
        end: 10,
      },
    ]);
  });

  it("leaves digits-only dollar amounts and compact monetary expressions as text", () => {
    expect(collectComposerInlineTokens("I'll pay $20 tomorrow")).toEqual([]);
    expect(collectComposerInlineTokens("Budget is $1_000 total")).toEqual([]);
    expect(collectComposerInlineTokens("Budget is $20k tomorrow")).toEqual([]);
    expect(collectComposerInlineTokens("Cost is $100M total")).toEqual([]);
    expect(collectComposerInlineTokens("Limit is $1e6 here")).toEqual([]);
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

  it("still collects a file link whose label is at the length cap", () => {
    const label = `${"a".repeat(508)}.tsx`;
    const tokens = collectComposerInlineTokens(`see [${label}](src/${label}) ok`);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.value).toBe(`src/${label}`);
  });

  it("leaves a file link past the label cap as plain text", () => {
    const label = `${"a".repeat(509)}.tsx`;
    expect(collectComposerInlineTokens(`see [${label}](src/${label}) ok`)).toEqual([]);
  });

  it("stays fast on unterminated bracket runs", () => {
    // Unbounded, the label body rescanned the rest of the text from every
    // whitespace: this input took seconds.
    const started = performance.now();
    expect(collectComposerInlineTokens(" [[".repeat(40_000))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
