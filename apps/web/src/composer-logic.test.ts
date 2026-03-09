import { describe, expect, it } from "vitest";

import {
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  isCollapsedCursorAdjacentToMention,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
} from "./composer-logic";

describe("detectComposerTrigger", () => {
  it("detects @path trigger at cursor", () => {
    const text = "Please check @src/com";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "path",
      query: "src/com",
      rangeStart: "Please check ".length,
      rangeEnd: text.length,
    });
  });

  it("detects slash command token while typing command name", () => {
    const text = "/mo";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "mo",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects slash model query after /model", () => {
    const text = "/model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-model",
      query: "spark",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects non-model slash commands while typing", () => {
    const text = "/pl";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "pl",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });
});

describe("replaceTextRange", () => {
  it("replaces a text range and returns new cursor", () => {
    const replaced = replaceTextRange("hello @src", 6, 10, "");
    expect(replaced).toEqual({
      text: "hello ",
      cursor: 6,
    });
  });
});

describe("expandCollapsedComposerCursor", () => {
  it("keeps cursor unchanged when no mention segment is present", () => {
    expect(expandCollapsedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps collapsed mention cursor to expanded text cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterMention)).toBe(
      expandedCursorAfterMention,
    );
  });

  it("allows path trigger detection to close after selecting a mention", () => {
    const text = "what's in my @AGENTS.md ";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursor = expandCollapsedComposerCursor(text, collapsedCursorAfterMention);

    expect(detectComposerTrigger(text, expandedCursor)).toBeNull();
  });
});

describe("isCollapsedCursorAdjacentToMention", () => {
  it("returns false when no mention exists", () => {
    expect(isCollapsedCursorAdjacentToMention("plain text", 6, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToMention("plain text", 6, "right")).toBe(false);
  });

  it("keeps @query typing non-adjacent while no mention pill exists", () => {
    const text = "hello @pac";
    expect(isCollapsedCursorAdjacentToMention(text, text.length, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToMention(text, text.length, "right")).toBe(false);
  });

  it("detects left adjacency only when cursor is directly after a mention", () => {
    const text = "open @AGENTS.md next";
    const mentionStart = "open ".length;
    const mentionEnd = mentionStart + 1;

    expect(isCollapsedCursorAdjacentToMention(text, mentionEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToMention(text, mentionStart, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToMention(text, mentionEnd + 1, "left")).toBe(false);
  });

  it("detects right adjacency only when cursor is directly before a mention", () => {
    const text = "open @AGENTS.md next";
    const mentionStart = "open ".length;
    const mentionEnd = mentionStart + 1;

    expect(isCollapsedCursorAdjacentToMention(text, mentionStart, "right")).toBe(true);
    expect(isCollapsedCursorAdjacentToMention(text, mentionEnd, "right")).toBe(false);
    expect(isCollapsedCursorAdjacentToMention(text, mentionStart - 1, "right")).toBe(false);
  });
});

describe("parseStandaloneComposerSlashCommand", () => {
  it("parses standalone /plan command", () => {
    expect(parseStandaloneComposerSlashCommand(" /plan ")).toBe("plan");
  });

  it("parses standalone /default command", () => {
    expect(parseStandaloneComposerSlashCommand("/default")).toBe("default");
  });

  it("parses standalone /checkout-pr command", () => {
    expect(parseStandaloneComposerSlashCommand(" /checkout-pr ")).toBe("checkout-pr");
  });

  it("ignores slash commands with extra message text", () => {
    expect(parseStandaloneComposerSlashCommand("/plan explain this")).toBeNull();
  });
});
