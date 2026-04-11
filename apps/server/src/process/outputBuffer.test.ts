import { describe, expect, it } from "vitest";

import { appendTextChunkWithinByteLimit, limitChunkToByteLimit } from "./outputBuffer";

describe("outputBuffer", () => {
  it("keeps a full chunk when it fits within the byte limit", () => {
    const chunk = Buffer.from("hello");

    expect(limitChunkToByteLimit(chunk, 2, 10)).toEqual({
      chunk,
      nextBytes: 7,
      truncated: false,
      overflow: false,
    });
  });

  it("truncates a chunk to the remaining byte budget", () => {
    const chunk = Buffer.from("abcdef");
    const limited = limitChunkToByteLimit(chunk, 3, 5);

    expect(Buffer.from(limited.chunk).toString()).toBe("ab");
    expect(limited.nextBytes).toBe(5);
    expect(limited.truncated).toBe(true);
    expect(limited.overflow).toBe(true);
  });

  it("appends only the bytes that fit", () => {
    expect(appendTextChunkWithinByteLimit("pre", 3, Buffer.from("abcdef"), 7)).toEqual({
      next: "preabcd",
      nextBytes: 7,
      truncated: true,
    });
  });
});
