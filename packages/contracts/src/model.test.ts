import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL, MODEL_OPTIONS, normalizeModelSlug, resolveModelSlug } from "./model";

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });

  it("preserves non-aliased model slugs", () => {
    expect(normalizeModelSlug("gpt-5.2")).toBe("gpt-5.2");
    expect(normalizeModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });
});

describe("resolveModelSlug", () => {
  it("returns default for missing and unknown models", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveModelSlug("gpt-4.1")).toBe(DEFAULT_MODEL);
  });

  it("resolves only supported model options", () => {
    for (const model of MODEL_OPTIONS) {
      expect(resolveModelSlug(model)).toBe(model);
    }
  });
});
