import { describe, it, expect } from "vite-plus/test";
import { isDefaultThreadTitle, sanitizeTitle, DEFAULT_THREAD_TITLE } from "./threadTitle.ts";

describe("isDefaultThreadTitle", () => {
  it("returns true for the default title", () => {
    expect(isDefaultThreadTitle("New thread")).toBe(true);
  });

  it("returns true for the default title with whitespace", () => {
    expect(isDefaultThreadTitle("  New thread  ")).toBe(true);
  });

  it("returns false for a custom title", () => {
    expect(isDefaultThreadTitle("My custom title")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isDefaultThreadTitle("")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isDefaultThreadTitle(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isDefaultThreadTitle(undefined)).toBe(false);
  });
});

describe("sanitizeTitle", () => {
  it("preserves a normal title", () => {
    expect(sanitizeTitle("Hello World")).toBe("Hello World");
  });

  it("trims whitespace", () => {
    expect(sanitizeTitle("  hello  ")).toBe("hello");
  });

  it("strips control characters", () => {
    expect(sanitizeTitle("hello\x00world")).toBe("helloworld");
    expect(sanitizeTitle("hello\x1Fworld")).toBe("helloworld");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(sanitizeTitle("   ")).toBe("");
    expect(sanitizeTitle(" \t ")).toBe("");
  });

  it("returns empty string for control-char-only input", () => {
    expect(sanitizeTitle("\x00")).toBe("");
    expect(sanitizeTitle("\x00\x00")).toBe("");
  });

  it("truncates to MAX_TITLE_LENGTH", () => {
    const long = "a".repeat(1000);
    expect(sanitizeTitle(long).length).toBe(500);
  });
});

describe("DEFAULT_THREAD_TITLE", () => {
  it("equals New thread", () => {
    expect(DEFAULT_THREAD_TITLE).toBe("New thread");
  });
});
