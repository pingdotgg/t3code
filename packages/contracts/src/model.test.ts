import { describe, expect, it } from "vitest";

import {
  CLAUDE_MODEL_OPTIONS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_MODEL,
  MODEL_OPTIONS,
  normalizeClaudeModelSlug,
  normalizeModelSlug,
  resolveClaudeModelSlug,
  resolveModelSlug,
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
});

describe("resolveModelSlug", () => {
  it("returns default for missing and unknown models", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveModelSlug("gpt-4.1")).toBe(DEFAULT_MODEL);
  });

  it("resolves only supported model options", () => {
    for (const model of MODEL_OPTIONS) {
      expect(resolveModelSlug(model.slug)).toBe(model.slug);
    }
  });
});

describe("normalizeClaudeModelSlug", () => {
  it("maps known aliases to canonical Claude slugs", () => {
    expect(normalizeClaudeModelSlug("sonnet")).toBe("sonnet");
    expect(normalizeClaudeModelSlug("opus")).toBe("opus");
    expect(normalizeClaudeModelSlug("claude-sonnet-4-6")).toBe("sonnet");
    expect(normalizeClaudeModelSlug("claude-opus-4-5")).toBe("opus");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeClaudeModelSlug("")).toBeNull();
    expect(normalizeClaudeModelSlug("   ")).toBeNull();
    expect(normalizeClaudeModelSlug(null)).toBeNull();
    expect(normalizeClaudeModelSlug(undefined)).toBeNull();
  });
});

describe("resolveClaudeModelSlug", () => {
  it("returns default for missing models only", () => {
    expect(resolveClaudeModelSlug(undefined)).toBe(DEFAULT_CLAUDE_MODEL);
    expect(resolveClaudeModelSlug("claude-3-5-sonnet")).toBe("claude-3-5-sonnet");
  });

  it("resolves only supported Claude model options", () => {
    for (const model of CLAUDE_MODEL_OPTIONS) {
      expect(resolveClaudeModelSlug(model.slug)).toBe(model.slug);
    }
  });
});
