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

  it("Given wide (CJK) text, when clipped, then truncates by display width, not code units", () => {
    // 8 CJK chars = 16 display columns; 10 columns leaves room for 4 chars + ellipsis.
    const result = clip("你好世界你好世界", 10);
    expect(result).toBe("你好世界…");
    expect(Bun.stringWidth(result)).toBeLessThanOrEqual(10);
  });

  it("Given emoji text, when clipped, then never splits a surrogate pair", () => {
    const result = clip("😀😀😀😀😀", 6);
    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toContain("�");
    for (const character of result.slice(0, -1)) {
      expect(character).toBe("😀");
    }
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
