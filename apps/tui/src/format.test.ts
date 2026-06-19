import { describe, expect, it } from "bun:test";

import { clip, padClip } from "./format.ts";

describe("clip", () => {
  it("Given text shorter than the width, when clipped, then returns it unchanged", () => {
    expect(clip("hello", 10)).toBe("hello");
  });

  it("Given text longer than the width, when clipped, then truncates with a trailing ellipsis to exactly width", () => {
    const result = clip("1234567890", 5);
    expect(result).toBe("1234…");
    expect([...result]).toHaveLength(5);
  });

  it("Given a non-positive width, when clipped, then returns an empty string", () => {
    expect(clip("hello", 0)).toBe("");
    expect(clip("hello", -3)).toBe("");
  });
});

describe("padClip", () => {
  it("Given text shorter than the width, when padded, then right-pads to exactly width", () => {
    const result = padClip("test", 10);
    expect(result).toBe("test      ");
    expect(result).toHaveLength(10);
  });

  it("Given text longer than the width, when padded, then clips (with ellipsis) to exactly width", () => {
    const result = padClip("12345678901234567890", 10);
    expect(result).toBe("123456789…");
    expect([...result]).toHaveLength(10);
  });
});
