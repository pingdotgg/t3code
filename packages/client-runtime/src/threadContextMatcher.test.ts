import { describe, expect, it } from "vitest";

import { matchThreadContextTitle } from "./threadContextMatcher.ts";

describe("matchThreadContextTitle", () => {
  it("matches case-insensitive substrings and rejects empty queries", () => {
    expect(matchThreadContextTitle("Auth refactor", "auth")).toBe(true);
    expect(matchThreadContextTitle("Auth refactor", "AUTH")).toBe(true);
    expect(matchThreadContextTitle("Auth refactor", "xyz")).toBe(false);
    expect(matchThreadContextTitle("Auth refactor", "")).toBe(false);
    expect(matchThreadContextTitle("Auth refactor", "   ")).toBe(false);
  });
});
