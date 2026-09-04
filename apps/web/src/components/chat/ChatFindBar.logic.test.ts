import { describe, expect, it } from "vite-plus/test";
import {
  buildChatFindPattern,
  countChatFindOccurrences,
  deriveChatFindMatches,
  resolveChatFindActiveIndex,
  resolveChatFindStartIndex,
  stepChatFindIndex,
} from "./ChatFindBar.logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

function messageRow(id: string, role: "user" | "assistant", text: string): MessagesTimelineRow {
  return {
    kind: "message",
    id,
    createdAt: "2026-01-01T00:00:00Z",
    message: {
      id: id as never,
      role,
      text,
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    },
    durationStart: "2026-01-01T00:00:00Z",
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  };
}

const foldRow: MessagesTimelineRow = {
  kind: "turn-fold",
  id: "turn-fold:turn-1",
  createdAt: "2026-01-01T00:00:00Z",
  turnId: "turn-1" as never,
  label: "Worked for 3s on error handling",
  expanded: false,
};

const rows: MessagesTimelineRow[] = [
  messageRow("user-1", "user", "Fix the Error in the parser"),
  foldRow,
  messageRow("assistant-1", "assistant", "No error here."),
  messageRow("user-2", "user", "still broken"),
  messageRow("assistant-2", "assistant", "Found the error; the ERROR was a typo. error fixed."),
];

function find(query: string, options?: Parameters<typeof buildChatFindPattern>[1]) {
  return deriveChatFindMatches(rows, buildChatFindPattern(query, options));
}

describe("buildChatFindPattern", () => {
  it("returns null for an empty or whitespace query", () => {
    expect(buildChatFindPattern("")).toBeNull();
    expect(buildChatFindPattern("   ")).toBeNull();
  });

  it("escapes regex metacharacters", () => {
    expect(countChatFindOccurrences("a.b a-b a.b", buildChatFindPattern("a.b")!)).toBe(2);
    expect(countChatFindOccurrences("x(1) x(2)", buildChatFindPattern("(1)")!)).toBe(1);
  });
});

describe("countChatFindOccurrences", () => {
  it("counts case-insensitive, non-overlapping occurrences by default", () => {
    expect(countChatFindOccurrences("Error error ERROR", buildChatFindPattern("error")!)).toBe(3);
    expect(countChatFindOccurrences("aaaa", buildChatFindPattern("aa")!)).toBe(2);
    expect(countChatFindOccurrences("nothing", buildChatFindPattern("error")!)).toBe(0);
  });

  it("honors case sensitivity", () => {
    const pattern = buildChatFindPattern("Error", { caseSensitive: true, wholeWord: false })!;
    expect(countChatFindOccurrences("Error error ERROR", pattern)).toBe(1);
  });

  it("honors whole word matching around punctuation and unicode letters", () => {
    const pattern = buildChatFindPattern("error", { caseSensitive: false, wholeWord: true })!;
    expect(countChatFindOccurrences("error errors (error) my_error Error.", pattern)).toBe(3);
    expect(countChatFindOccurrences("erroré", pattern)).toBe(0);
    const dotted = buildChatFindPattern("foo.", { caseSensitive: false, wholeWord: true })!;
    expect(countChatFindOccurrences("foo. foo.bar", dotted)).toBe(1);
  });
});

describe("deriveChatFindMatches", () => {
  it("returns nothing without a pattern", () => {
    expect(deriveChatFindMatches(rows, null)).toEqual([]);
  });

  it("lists one match per occurrence in timeline order and skips non-message rows", () => {
    expect(find(" error ")).toEqual([
      { rowId: "user-1", rowIndex: 0, occurrence: 0 },
      { rowId: "assistant-1", rowIndex: 2, occurrence: 0 },
      { rowId: "assistant-2", rowIndex: 4, occurrence: 0 },
      { rowId: "assistant-2", rowIndex: 4, occurrence: 1 },
      { rowId: "assistant-2", rowIndex: 4, occurrence: 2 },
    ]);
    expect(find("Worked for")).toEqual([]);
  });

  it("applies the match options to every row", () => {
    expect(find("ERROR", { caseSensitive: true, wholeWord: false })).toEqual([
      { rowId: "assistant-2", rowIndex: 4, occurrence: 0 },
    ]);
    expect(find("Error", { caseSensitive: false, wholeWord: true })).toHaveLength(5);
  });
});

describe("stepChatFindIndex", () => {
  it("wraps in both directions and tolerates a single match", () => {
    expect(stepChatFindIndex(0, 3, 1)).toBe(1);
    expect(stepChatFindIndex(2, 3, 1)).toBe(0);
    expect(stepChatFindIndex(0, 3, -1)).toBe(2);
    expect(stepChatFindIndex(0, 1, 1)).toBe(0);
    expect(stepChatFindIndex(0, 1, -1)).toBe(0);
    expect(stepChatFindIndex(4, 0, 1)).toBe(0);
  });
});

describe("resolveChatFindActiveIndex", () => {
  const matches = find("error");

  it("follows the same occurrence when rows shift underneath it", () => {
    const previous = matches[3]!;
    const shifted = deriveChatFindMatches(
      [messageRow("user-0", "user", "hi"), ...rows],
      buildChatFindPattern("error"),
    );
    expect(resolveChatFindActiveIndex(shifted, 3, previous)).toBe(3);
    expect(shifted[3]).toEqual({ rowId: "assistant-2", rowIndex: 5, occurrence: 1 });
  });

  it("clamps when the previous occurrence is gone", () => {
    const previous = matches[4]!;
    const fewer = deriveChatFindMatches(rows.slice(0, 3), buildChatFindPattern("error"));
    expect(resolveChatFindActiveIndex(fewer, 4, previous)).toBe(1);
    expect(resolveChatFindActiveIndex([], 4, previous)).toBe(0);
    expect(resolveChatFindActiveIndex(matches, -2, null)).toBe(0);
  });
});

describe("resolveChatFindStartIndex", () => {
  const matches = find("error");

  it("starts at the first match at or after the visible row", () => {
    expect(resolveChatFindStartIndex(matches, null)).toBe(0);
    expect(resolveChatFindStartIndex(matches, 0)).toBe(0);
    expect(resolveChatFindStartIndex(matches, 1)).toBe(1);
    expect(resolveChatFindStartIndex(matches, 3)).toBe(2);
  });

  it("falls back to the first match when nothing follows the visible row", () => {
    expect(resolveChatFindStartIndex(matches, 10)).toBe(0);
  });
});
