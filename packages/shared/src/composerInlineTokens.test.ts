import { describe, expect, it } from "vite-plus/test";

import { collectComposerInlineTokens } from "./composerInlineTokens.ts";

describe("collectComposerInlineTokens", () => {
  it("collects file links, mentions, skills, and thread references with source ranges", () => {
    const text =
      "Use $ui and inspect [Chat.tsx](src/Chat.tsx) with @AGENTS.md then [Prior chat](t3-thread:///env-1/thread-2) please";

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
      {
        type: "thread",
        environmentId: "env-1",
        threadId: "thread-2",
        title: "Prior chat",
        value: "Prior chat",
        source: "[Prior chat](t3-thread:///env-1/thread-2)",
        start: 66,
        end: 107,
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

  it("ignores malformed thread links", () => {
    expect(collectComposerInlineTokens("Read [chat](t3-thread:///missing) first")).toEqual([]);
  });

  it("collects a complete thread reference at the end of the prompt", () => {
    expect(
      collectComposerInlineTokens("Read [chat](t3-thread:///environment-1/thread-1)"),
    ).toMatchObject([
      {
        type: "thread",
        environmentId: "environment-1",
        threadId: "thread-1",
        title: "chat",
      },
    ]);
  });

  it.each([".", ",", ";", ":", "!", "?", ")", '"'])(
    "collects a thread reference followed by %s without consuming the punctuation",
    (punctuation) => {
      const reference = "[chat](t3-thread:///environment-1/thread-1)";
      const text = `Read ${reference}${punctuation}`;
      const referenceEnd = 5 + reference.length;

      expect(collectComposerInlineTokens(text)).toMatchObject([
        {
          type: "thread",
          environmentId: "environment-1",
          threadId: "thread-1",
          source: reference,
          start: 5,
          end: referenceEnd,
        },
      ]);
      expect(text.slice(referenceEnd)).toBe(punctuation);
    },
  );
});
