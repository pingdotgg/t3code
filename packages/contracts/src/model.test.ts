import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_OPTIONS,
  MODEL_OPTIONS_BY_PROVIDER,
  getDefaultModel,
  getModelOptions,
  getReasoningOptions,
  normalizeModelSlug,
  REASONING_OPTIONS,
  resolveModelSlug,
  resolveModelSlugForProvider,
} from "./model";

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

  it("uses provider-specific aliases", () => {
    expect(normalizeModelSlug("sonnet", "claudeCode")).toBe("claude-sonnet-4-6");
    expect(normalizeModelSlug("opus-4.6", "claudeCode")).toBe("claude-opus-4-6");
    expect(normalizeModelSlug("claude-haiku-4-5-20251001", "claudeCode")).toBe(
      "claude-haiku-4-5",
    );
  });
});

describe("resolveModelSlug", () => {
  it("returns default only when the model is missing", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveModelSlug(null)).toBe(DEFAULT_MODEL);
  });

  it("preserves unknown custom models", () => {
    expect(resolveModelSlug("gpt-4.1")).toBe("gpt-4.1");
    expect(resolveModelSlug("custom/internal-model")).toBe("custom/internal-model");
  });

  it("resolves only supported model options", () => {
    for (const model of MODEL_OPTIONS) {
      expect(resolveModelSlug(model.slug)).toBe(model.slug);
    }
  });

  it("supports provider-aware resolution", () => {
    expect(resolveModelSlugForProvider("claudeCode", undefined)).toBe(
      DEFAULT_MODEL_BY_PROVIDER.claudeCode,
    );
    expect(resolveModelSlugForProvider("claudeCode", "sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveModelSlugForProvider("claudeCode", "gpt-5.3-codex")).toBe(
      DEFAULT_MODEL_BY_PROVIDER.claudeCode,
    );
  });

  it("keeps codex defaults for backward compatibility", () => {
    expect(getDefaultModel()).toBe(DEFAULT_MODEL);
    expect(getModelOptions()).toEqual(MODEL_OPTIONS);
    expect(getModelOptions("claudeCode")).toEqual(MODEL_OPTIONS_BY_PROVIDER.claudeCode);
  });
});

describe("getReasoningOptions", () => {
  it("returns codex reasoning options for codex", () => {
    expect(getReasoningOptions("codex")).toEqual(REASONING_OPTIONS);
  });

  it("returns no reasoning options for claudeCode", () => {
    expect(getReasoningOptions("claudeCode")).toEqual([]);
  });
});
