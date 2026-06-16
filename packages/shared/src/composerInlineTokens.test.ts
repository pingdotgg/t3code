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
});
