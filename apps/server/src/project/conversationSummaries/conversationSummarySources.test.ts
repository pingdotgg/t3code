import { describe, expect, it } from "@effect/vitest";
import { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  MAX_SOURCE_CHARS,
  sourceRanges,
  type SummarySource,
} from "./conversationSummarySources.ts";

const source = (text: string): SummarySource => ({
  ref: {
    kind: "turn_item",
    threadId: ThreadId.make("source-thread"),
    itemId: TurnItemId.make("source-item"),
    digest: "a".repeat(64),
  },
  role: "tool",
  text,
  createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
});

describe("sourceRanges", () => {
  it.each(["\n", "\r\n", "\\n", "\\r\\n"])(
    "keeps a search-result line together across %j boundaries",
    (newline) => {
      const prefix = `${"x".repeat(5_950)}${newline}`;
      const hit = `src/link.rs:478:${"call_with_context".repeat(10)}`;
      const text = `${prefix}${hit}${newline}src/plan.rs:90:other_call()`;
      const ranges = sourceRanges(source(text));
      expect(ranges[0]?.text).toBe(prefix);
      expect(ranges[1]?.text).toContain(hit);
      expect(ranges.map((range) => range.text).join("")).toBe(text);
      expect(ranges.every((range) => range.text.length <= MAX_SOURCE_CHARS)).toBe(true);
      expect(ranges[1]?.ref.range?.start).toBe(prefix.length);
    },
  );

  it("bounds unbroken lines without splitting surrogate pairs or losing the suffix", () => {
    const text = `short\n${"a".repeat(5_993)}🧪${"b".repeat(6_100)}TAIL`;
    const ranges = sourceRanges(source(text));
    expect(ranges[0]?.text.length).toBe(5_999);
    expect(
      ranges.every(
        (range) =>
          range.text.length > 0 &&
          range.text.length <= MAX_SOURCE_CHARS &&
          range.text.isWellFormed(),
      ),
    ).toBe(true);
    expect(ranges.map((range) => range.text).join("")).toBe(text);
  });
});
