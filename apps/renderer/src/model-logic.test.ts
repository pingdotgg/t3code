import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, normalizeModelSlug, resolveModelSlug } from "./model-logic";

describe("normalizeModelSlug", () => {
  it("maps 5.3 aliases to canonical codex slug", () => {
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
  });

  it("preserves non-aliased slugs", () => {
    expect(normalizeModelSlug("gpt-5.3-codex")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });

  it("returns null for empty input", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });
});

describe("resolveModelSlug", () => {
  it("falls back to default for unknown models", () => {
    expect(resolveModelSlug("gpt-4.1")).toBe(DEFAULT_MODEL);
  });

  it("resolves supported hard-coded models", () => {
    expect(resolveModelSlug("gpt-5.3-codex")).toBe("gpt-5.3-codex");
    expect(resolveModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
    expect(resolveModelSlug("gpt-5.2")).toBe("gpt-5.2");
  });
});
