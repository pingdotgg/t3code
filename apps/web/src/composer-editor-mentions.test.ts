import { describe, expect, it } from "vitest";

import {
  selectionTouchesMentionBoundary,
  splitPromptIntoComposerSegments,
} from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("splitPromptIntoComposerSegments", () => {
  it("splits mention tokens followed by whitespace into mention segments", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md please")).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "AGENTS.md" },
      { type: "text", text: " please" },
    ]);
  });

  it("does not convert an incomplete trailing mention token", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md")).toEqual([
      { type: "text", text: "Inspect @AGENTS.md" },
    ]);
  });

  it("keeps newlines around mention tokens", () => {
    expect(splitPromptIntoComposerSegments("one\n@src/index.ts \ntwo")).toEqual([
      { type: "text", text: "one\n" },
      { type: "mention", path: "src/index.ts" },
      { type: "text", text: " \ntwo" },
    ]);
  });

  it("splits quoted mention tokens containing whitespace", () => {
    expect(splitPromptIntoComposerSegments('Inspect @"My File.md" please')).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "My File.md" },
      { type: "text", text: " please" },
    ]);
  });

  it("unescapes quoted mention token content", () => {
    expect(splitPromptIntoComposerSegments('Inspect @"docs/My \\"File\\".md" please')).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: 'docs/My "File".md' },
      { type: "text", text: " please" },
    ]);
  });

  it("splits skill tokens followed by whitespace into skill segments", () => {
    expect(splitPromptIntoComposerSegments("Use $review-follow-up please")).toEqual([
      { type: "text", text: "Use " },
      { type: "skill", name: "review-follow-up" },
      { type: "text", text: " please" },
    ]);
  });

  it("does not convert an incomplete trailing skill token", () => {
    expect(splitPromptIntoComposerSegments("Use $review-follow-up")).toEqual([
      { type: "text", text: "Use $review-follow-up" },
    ]);
  });

  it("keeps inline terminal context placeholders at their prompt positions", () => {
    expect(
      splitPromptIntoComposerSegments(
        `Inspect ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md please`,
      ),
    ).toEqual([
      { type: "text", text: "Inspect " },
      { type: "terminal-context", context: null },
      { type: "mention", path: "AGENTS.md" },
      { type: "text", text: " please" },
    ]);
  });

  it("preserves consecutive terminal context placeholders without dropping positions", () => {
    expect(
      splitPromptIntoComposerSegments(
        `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}tail`,
      ),
    ).toEqual([
      { type: "terminal-context", context: null },
      { type: "terminal-context", context: null },
      { type: "text", text: "tail" },
    ]);
  });

  it("keeps skill parsing alongside mentions and terminal placeholders", () => {
    expect(
      splitPromptIntoComposerSegments(
        `Inspect ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}$review-follow-up after @AGENTS.md `,
      ),
    ).toEqual([
      { type: "text", text: "Inspect " },
      { type: "terminal-context", context: null },
      { type: "skill", name: "review-follow-up" },
      { type: "text", text: " after " },
      { type: "mention", path: "AGENTS.md" },
      { type: "text", text: " " },
    ]);
  });
});

describe("selectionTouchesMentionBoundary", () => {
  it("returns true when selection includes the whitespace after a mention", () => {
    expect(
      selectionTouchesMentionBoundary(
        "hi @package.json there",
        "hi @package.json".length,
        "hi @package.json there".length,
      ),
    ).toBe(true);
  });

  it("returns true when selection includes the whitespace before a mention", () => {
    expect(
      selectionTouchesMentionBoundary(
        "hi there @package.json later",
        "hi there".length,
        "hi there ".length,
      ),
    ).toBe(true);
  });

  it("returns false when selection starts after the mention boundary whitespace", () => {
    expect(
      selectionTouchesMentionBoundary(
        "hi @package.json there",
        "hi @package.json ".length,
        "hi @package.json there".length,
      ),
    ).toBe(false);
  });

  it("returns true when selection includes whitespace after a mention following a terminal placeholder", () => {
    const prompt = `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md there`;
    expect(
      selectionTouchesMentionBoundary(
        prompt,
        `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md`.length,
        prompt.length,
      ),
    ).toBe(true);
  });

  it("returns true when selection includes whitespace after a quoted mention", () => {
    expect(
      selectionTouchesMentionBoundary(
        'hi @"My File.md" there',
        'hi @"My File.md"'.length,
        'hi @"My File.md" there'.length,
      ),
    ).toBe(true);
  });
});

describe("thread context segments", () => {
  it("parses inline thread references into atomic thread-context segments", () => {
    expect(
      splitPromptIntoComposerSegments("see [Auth](t3-context://v1/thread/ctx-1) please"),
    ).toEqual([
      { type: "text", text: "see " },
      { type: "thread-context", contextId: "ctx-1", label: "Auth" },
      { type: "text", text: " please" },
    ]);
  });

  it("keeps multiple thread references in order without swallowing surrounding text", () => {
    expect(
      splitPromptIntoComposerSegments(
        "[A](t3-context://v1/thread/ctx-a) plus [B](t3-context://v1/thread/ctx-b)",
      ),
    ).toEqual([
      { type: "thread-context", contextId: "ctx-a", label: "A" },
      { type: "text", text: " plus " },
      { type: "thread-context", contextId: "ctx-b", label: "B" },
    ]);
  });

  it("does not parse mention tokens inside a thread reference label", () => {
    const segments = splitPromptIntoComposerSegments("[a@b](t3-context://v1/thread/ctx-9) ");
    expect(segments).toEqual([
      { type: "thread-context", contextId: "ctx-9", label: "a@b" },
      { type: "text", text: " " },
    ]);
  });
});
