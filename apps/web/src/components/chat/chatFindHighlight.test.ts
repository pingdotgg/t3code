import { describe, expect, it } from "vite-plus/test";

import { buildChatFindPattern, findPatternSpans } from "./ChatFind.logic";
import { resolveChunkBoundaries } from "./chatFindHighlight";

// Rendered text "Hello\nbold world" from <p>Hello</p><p><b>bold</b> world</p>:
// chunk offsets skip the block separator at index 5.
const chunks = [
  { id: "hello", start: 0, end: 5 },
  { id: "bold", start: 6, end: 10 },
  { id: "world", start: 10, end: 16 },
];
const text = "Hello\nbold world";

describe("resolveChunkBoundaries", () => {
  it("maps a span inside one text node", () => {
    const [span] = findPatternSpans(text, buildChatFindPattern("ell")!);
    expect(resolveChunkBoundaries(chunks, span!)).toEqual({
      start: { chunk: chunks[0], offset: 1 },
      end: { chunk: chunks[0], offset: 4 },
    });
  });

  it("spans inline markup across text nodes", () => {
    const [span] = findPatternSpans(text, buildChatFindPattern("bold wor")!);
    expect(resolveChunkBoundaries(chunks, span!)).toEqual({
      start: { chunk: chunks[1], offset: 0 },
      end: { chunk: chunks[2], offset: 4 },
    });
  });

  it("crosses a block separator when the query has whitespace", () => {
    const [span] = findPatternSpans(text, buildChatFindPattern("hello bold")!);
    expect(resolveChunkBoundaries(chunks, span!)).toEqual({
      start: { chunk: chunks[0], offset: 0 },
      end: { chunk: chunks[1], offset: 4 },
    });
  });

  it("rejects a span that only covers separators", () => {
    expect(resolveChunkBoundaries(chunks, { start: 5, end: 6 })).toBeNull();
  });
});
