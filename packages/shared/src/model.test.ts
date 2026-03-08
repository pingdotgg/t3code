import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_BY_PROVIDER, MODEL_OPTIONS_BY_PROVIDER } from "@t3tools/contracts";

import {
  getDefaultModel,
  getDefaultReasoningEffort,
  getModelOptions,
  getReasoningEffortOptions,
  normalizeModelSlug,
  resolveModelSlug,
  resolveReasoningEffortForProvider,
  supportsReasoningEffortForModel,
} from "./model";

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("sonnet-4.6", "claudeCode")).toBe("claude-sonnet-4-6");
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

  it("does not leak prototype properties as aliases", () => {
    expect(normalizeModelSlug("toString")).toBe("toString");
    expect(normalizeModelSlug("constructor")).toBe("constructor");
  });
});

describe("resolveModelSlug", () => {
  it("returns default only when the model is missing", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug(null)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("preserves unknown custom models", () => {
    expect(resolveModelSlug("gpt-4.1")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug("custom/internal-model")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("resolves only supported model options", () => {
    for (const model of MODEL_OPTIONS_BY_PROVIDER.codex) {
      expect(resolveModelSlug(model.slug)).toBe(model.slug);
    }
    for (const model of MODEL_OPTIONS_BY_PROVIDER.claudeCode) {
      expect(resolveModelSlug(model.slug, "claudeCode")).toBe(model.slug);
    }
  });
  it("keeps codex defaults for backward compatibility", () => {
    expect(getDefaultModel()).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(getModelOptions()).toEqual(MODEL_OPTIONS_BY_PROVIDER.codex);
  });

  it("returns Claude Code defaults when requested", () => {
    expect(getDefaultModel("claudeCode")).toBe(DEFAULT_MODEL_BY_PROVIDER.claudeCode);
    expect(getModelOptions("claudeCode")).toEqual(MODEL_OPTIONS_BY_PROVIDER.claudeCode);
  });
});

describe("getReasoningEffortOptions", () => {
  it("returns codex reasoning options for codex", () => {
    expect(getReasoningEffortOptions("codex")).toEqual(["xhigh", "high", "medium", "low"]);
  });

  it("returns Claude Code reasoning options for Claude Code", () => {
    expect(getReasoningEffortOptions("claudeCode")).toEqual(["high", "medium", "low"]);
  });
});

describe("getDefaultReasoningEffort", () => {
  it("returns provider-scoped defaults", () => {
    expect(getDefaultReasoningEffort("codex")).toBe("high");
    expect(getDefaultReasoningEffort("claudeCode")).toBe("medium");
  });
});

describe("resolveReasoningEffortForProvider", () => {
  it("falls back to provider defaults when the draft is empty or incompatible", () => {
    expect(resolveReasoningEffortForProvider("codex", null)).toBe("high");
    expect(resolveReasoningEffortForProvider("claudeCode", null)).toBe("medium");
    expect(resolveReasoningEffortForProvider("claudeCode", "xhigh")).toBe("medium");
  });
});

describe("supportsReasoningEffortForModel", () => {
  it("allows Codex reasoning effort for Codex models", () => {
    expect(supportsReasoningEffortForModel("codex", "gpt-5.4")).toBe(true);
  });

  it("detects supported Claude Code models and aliases", () => {
    expect(supportsReasoningEffortForModel("claudeCode", "sonnet")).toBe(true);
    expect(supportsReasoningEffortForModel("claudeCode", "claude-opus-4-6")).toBe(true);
    expect(supportsReasoningEffortForModel("claudeCode", "sonnet[1m]")).toBe(true);
    expect(supportsReasoningEffortForModel("claudeCode", "claude-3-7-sonnet")).toBe(false);
  });
});
