import { describe, expect, it } from "bun:test";

import {
  encodeKittyUnicodePlaceholder,
  KITTY_UNICODE_PLACEHOLDER_LIMIT,
} from "./unicodePlaceholder.ts";

describe("Kitty Unicode placeholders", () => {
  it("encodes the canonical placeholder with explicit row and column diacritics", () => {
    expect(encodeKittyUnicodePlaceholder(0, 1)).toBe("\u{10eeee}\u0305\u030d");
    expect(encodeKittyUnicodePlaceholder(1, 0)).toBe("\u{10eeee}\u030d\u0305");
  });

  it("rejects coordinates beyond Kitty's canonical diacritic table", () => {
    expect(() => encodeKittyUnicodePlaceholder(KITTY_UNICODE_PLACEHOLDER_LIMIT, 0)).toThrow(
      `below ${KITTY_UNICODE_PLACEHOLDER_LIMIT}`,
    );
  });
});
