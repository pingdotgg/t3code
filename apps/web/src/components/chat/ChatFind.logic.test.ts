import { describe, expect, it } from "vite-plus/test";
import { MessageId, TurnId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";
import {
  buildChatFindPattern,
  chatFindEntrySource,
  collectChatFindMatches,
  findPatternSpans,
  formatChatFindCount,
  markdownSearchText,
  resolveActiveMatchIndex,
  stepChatFindIndex,
} from "./ChatFind.logic";

const at = "2026-01-01T00:00:00.000Z";

function message(
  id: string,
  text: string,
  options: { turnId?: string | null; role?: "user" | "assistant" | "reasoning" | "system" } = {},
): TimelineEntry {
  const turnId = options.turnId === undefined ? "turn-1" : options.turnId;
  return {
    id,
    kind: "message",
    createdAt: at,
    message: {
      id: MessageId.make(id),
      role: options.role ?? "user",
      text,
      turnId: turnId === null ? null : TurnId.make(turnId),
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  };
}

function plan(id: string, planMarkdown: string): TimelineEntry {
  return {
    id,
    kind: "proposed-plan",
    createdAt: at,
    proposedPlan: {
      id,
      turnId: TurnId.make("plan-turn"),
      planMarkdown,
      implementedAt: null,
      implementationThreadId: null,
      createdAt: at,
      updatedAt: at,
    },
  };
}

describe("buildChatFindPattern", () => {
  it("returns null for blank queries", () => {
    expect(buildChatFindPattern("")).toBeNull();
    expect(buildChatFindPattern("   ")).toBeNull();
  });

  it("matches literally and case-insensitively", () => {
    const pattern = buildChatFindPattern("a.b(c)")!;
    expect(findPatternSpans("x A.B(C) y a.b(c)", pattern)).toEqual([
      { start: 2, end: 8 },
      { start: 11, end: 17 },
    ]);
    expect(findPatternSpans("axb(c)", pattern)).toEqual([]);
  });

  it("lets query whitespace match any whitespace run", () => {
    const pattern = buildChatFindPattern("  hello   world ")!;
    expect(findPatternSpans("hello\n  world", pattern)).toEqual([{ start: 0, end: 13 }]);
    expect(findPatternSpans("helloworld", pattern)).toEqual([]);
  });
});

describe("markdownSearchText", () => {
  it("drops delimiters and link targets but keeps their text", () => {
    expect(
      markdownSearchText("Use **bold** and _em_ with `code` and [docs](https://x.test/a)."),
    ).toBe("Use bold and em with code and docs.");
    expect(markdownSearchText("![alt text](https://x.test/i.png) <https://x.test>")).toBe(
      "alt text https://x.test",
    );
  });

  it("drops block markers but keeps content", () => {
    const text = markdownSearchText(
      "# Title\n\n> quoted\n\n- [ ] task one\n1. step\n\n```ts\nconst a = 1;\n```",
    );
    // Whitespace runs collapse in the pattern, so only the words matter here.
    expect(text.replace(/\s+/g, " ").trim()).toBe("Title quoted task one step const a = 1;");
  });

  it("keeps HTML-shaped text inside code while dropping real tags", () => {
    const text = markdownSearchText(
      "Use `<div>` here\n\n```html\n<p>hi **there**</p>\n```\n\n<span>real</span>",
    );
    expect(text.replace(/\s+/g, " ").trim()).toBe("Use <div> here <p>hi **there**</p> real");
  });

  it("does not count a delimiter-only query", () => {
    const entries = [message("m1", "Use **bold** here")];
    expect(collectChatFindMatches(entries, buildChatFindPattern("**"))).toEqual([]);
    expect(collectChatFindMatches(entries, buildChatFindPattern("bold"))).toHaveLength(1);
  });
});

describe("collectChatFindMatches", () => {
  it("lists one match per occurrence in timeline order, for messages and plans", () => {
    const entries = [
      message("m1", "Fix the login bug", { turnId: "t1" }),
      message("m2", "No match here", { turnId: "t1", role: "assistant" }),
      plan("p1", "# Plan\n\n1. Reproduce the login bug\n2. Fix login"),
      message("m3", "login", { turnId: null }),
    ];
    expect(collectChatFindMatches(entries, buildChatFindPattern("LOGIN"))).toEqual([
      { entryId: "m1", turnId: TurnId.make("t1"), occurrence: 0 },
      { entryId: "p1", turnId: TurnId.make("plan-turn"), occurrence: 0 },
      { entryId: "p1", turnId: TurnId.make("plan-turn"), occurrence: 1 },
      { entryId: "m3", turnId: null, occurrence: 0 },
    ]);
  });

  it("returns nothing without a pattern", () => {
    expect(collectChatFindMatches([message("m1", "text")], null)).toEqual([]);
  });

  it("skips entries that are not messages or plans", () => {
    expect(chatFindEntrySource({ kind: "work" } as unknown as TimelineEntry)).toBeNull();
  });

  it("skips thinking and system messages, which have no row of their own", () => {
    const entries = [
      message("r1", "login thoughts", { role: "reasoning" }),
      message("s1", "login system note", { role: "system" }),
      message("a1", "login answer", { role: "assistant" }),
    ];
    expect(collectChatFindMatches(entries, buildChatFindPattern("login"))).toEqual([
      { entryId: "a1", turnId: TurnId.make("turn-1"), occurrence: 0 },
    ]);
  });
});

describe("active match selection", () => {
  const matches = collectChatFindMatches(
    [message("m1", "a a"), message("m2", "a")],
    buildChatFindPattern("a"),
  );

  it("keeps the active match by identity when the list shifts", () => {
    const active = matches[2]!;
    const prepended = collectChatFindMatches(
      [message("m0", "a"), message("m1", "a a"), message("m2", "a")],
      buildChatFindPattern("a"),
    );
    expect(resolveActiveMatchIndex(prepended, active)).toBe(3);
  });

  it("falls back to the first match when the active one is gone", () => {
    expect(resolveActiveMatchIndex(matches, { entryId: "gone", turnId: null, occurrence: 0 })).toBe(
      0,
    );
    expect(resolveActiveMatchIndex(matches, null)).toBe(0);
    expect(resolveActiveMatchIndex([], matches[0]!)).toBe(-1);
  });

  it("steps with wrap-around", () => {
    expect(stepChatFindIndex(0, 3, 1)).toBe(1);
    expect(stepChatFindIndex(2, 3, 1)).toBe(0);
    expect(stepChatFindIndex(0, 3, -1)).toBe(2);
    expect(stepChatFindIndex(-1, 3, -1)).toBe(2);
    expect(stepChatFindIndex(0, 0, 1)).toBe(-1);
  });

  it("formats the counter", () => {
    expect(formatChatFindCount(-1, 0)).toBe("No results");
    expect(formatChatFindCount(1, 3)).toBe("2/3");
  });
});
