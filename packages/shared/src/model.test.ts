import { describe, expect, it } from "vitest";
import {
  CURSOR_MODEL_FAMILY_OPTIONS,
  CURSOR_REASONING_OPTIONS,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  MODEL_OPTIONS,
  MODEL_OPTIONS_BY_PROVIDER,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
} from "@t3tools/contracts";

import {
  getDefaultModel,
  getDefaultReasoningEffort,
  getCursorModelFamilyOptions,
  getModelOptions,
  getReasoningEffortOptions,
  normalizeModelSlug,
  parseCursorModelSelection,
  resolveCursorPickerModelSlug,
  resolveCursorModelFromSelection,
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
    expect(normalizeModelSlug("composer", "cursor")).toBe("composer-1.5");
    expect(normalizeModelSlug("gpt-5.3-codex-spark", "cursor")).toBe(
      "gpt-5.3-codex-spark-preview",
    );
    expect(normalizeModelSlug("gpt-5.4", "cursor")).toBe("gpt-5.4-medium");
    expect(normalizeModelSlug("gpt-5.2-codex", "cursor")).toBe("gpt-5.2-codex");
    expect(normalizeModelSlug("gemini-3.1", "cursor")).toBe("gemini-3.1-pro");
    expect(normalizeModelSlug("claude-4.6-sonnet-thinking", "cursor")).toBe(
      "sonnet-4.6-thinking",
    );
    expect(normalizeModelSlug("claude-4.5-sonnet-thinking", "cursor")).toBe(
      "sonnet-4.5-thinking",
    );
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
  });

  it("supports provider-aware resolution", () => {
    expect(resolveModelSlugForProvider("claudeCode", undefined)).toBe(
      DEFAULT_MODEL_BY_PROVIDER.claudeCode,
    );
    expect(resolveModelSlugForProvider("claudeCode", "sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveModelSlugForProvider("claudeCode", "gpt-5.3-codex")).toBe(
      DEFAULT_MODEL_BY_PROVIDER.claudeCode,
    );
    expect(resolveModelSlugForProvider("cursor", undefined)).toBe(
      DEFAULT_MODEL_BY_PROVIDER.cursor,
    );
    expect(resolveModelSlugForProvider("cursor", "composer")).toBe("composer-1.5");
    expect(resolveModelSlugForProvider("cursor", "gpt-5.3-codex-high-fast")).toBe(
      "gpt-5.3-codex-high-fast",
    );
    expect(resolveModelSlugForProvider("cursor", "claude-sonnet-4-6")).toBe(
      DEFAULT_MODEL_BY_PROVIDER.cursor,
    );
  });

  it("keeps codex defaults for backward compatibility", () => {
    expect(getDefaultModel()).toBe(DEFAULT_MODEL);
    expect(getModelOptions()).toEqual(MODEL_OPTIONS);
    expect(getModelOptions("claudeCode")).toEqual(MODEL_OPTIONS_BY_PROVIDER.claudeCode);
    expect(getModelOptions("cursor")).toEqual(MODEL_OPTIONS_BY_PROVIDER.cursor);
    expect(getCursorModelFamilyOptions()).toEqual(CURSOR_MODEL_FAMILY_OPTIONS);
  });
});

describe("cursor model selection", () => {
  it("includes the expected cursor reasoning levels and families", () => {
    expect(CURSOR_REASONING_OPTIONS).toEqual(["low", "normal", "high", "xhigh"]);
    expect(getCursorModelFamilyOptions().map((option) => option.slug)).toContain("gpt-5.3-codex");
    expect(getCursorModelFamilyOptions().map((option) => option.slug)).toContain("gpt-5.2-codex");
    expect(getCursorModelFamilyOptions().map((option) => option.slug)).toContain("gpt-5.4-medium");
    expect(getCursorModelFamilyOptions().map((option) => option.slug)).toContain("opus-4.6");
    expect(getCursorModelFamilyOptions().map((option) => option.slug)).toContain("sonnet-4.5");
  });

  it("parses codex reasoning and fast mode variants", () => {
    expect(parseCursorModelSelection("gpt-5.3-codex-high-fast")).toEqual({
      family: "gpt-5.3-codex",
      reasoning: "high",
      fast: true,
      thinking: false,
    });
    expect(parseCursorModelSelection("gpt-5.2-codex")).toEqual({
      family: "gpt-5.2-codex",
      reasoning: "normal",
      fast: false,
      thinking: false,
    });
  });

  it("parses newer cursor codex reasoning variants", () => {
    expect(parseCursorModelSelection("gpt-5.2-codex-high-fast")).toEqual({
      family: "gpt-5.2-codex",
      reasoning: "high",
      fast: true,
      thinking: false,
    });
    expect(
      resolveCursorModelFromSelection({
        family: "gpt-5.2-codex",
        reasoning: "xhigh",
        fast: true,
      }),
    ).toBe("gpt-5.2-codex-xhigh-fast");
  });

  it("parses and resolves thinking variants", () => {
    expect(parseCursorModelSelection("sonnet-4.6-thinking")).toEqual({
      family: "sonnet-4.6",
      reasoning: "normal",
      fast: false,
      thinking: true,
    });
    expect(
      resolveCursorModelFromSelection({
        family: "sonnet-4.6",
        thinking: true,
      }),
    ).toBe("sonnet-4.6-thinking");
    expect(parseCursorModelSelection("sonnet-4.5-thinking")).toEqual({
      family: "sonnet-4.5",
      reasoning: "normal",
      fast: false,
      thinking: true,
    });
  });

  it("resolves codex family selections into concrete model ids", () => {
    expect(
      resolveCursorModelFromSelection({
        family: "gpt-5.3-codex",
        reasoning: "xhigh",
        fast: true,
      }),
    ).toBe("gpt-5.3-codex-xhigh-fast");
  });

  it("collapses trait-backed cursor variants to a single picker option", () => {
    expect(resolveCursorPickerModelSlug("gpt-5.2-codex-high-fast")).toBe("gpt-5.2-codex");
    expect(resolveCursorPickerModelSlug("opus-4.6-thinking")).toBe("opus-4.6");
    expect(resolveCursorPickerModelSlug("sonnet-4.5-thinking")).toBe("sonnet-4.5");
    expect(resolveCursorPickerModelSlug("gpt-5.4-high-fast")).toBe("gpt-5.4-high-fast");
  });
});

describe("getReasoningEffortOptions", () => {
  it("returns codex reasoning options for codex", () => {
    expect(getReasoningEffortOptions("codex")).toEqual(
      REASONING_EFFORT_OPTIONS_BY_PROVIDER.codex,
    );
  });

  it("returns no reasoning options for claudeCode", () => {
    expect(getReasoningEffortOptions("claudeCode")).toEqual([]);
  });

  it("returns no reasoning options for cursor", () => {
    expect(getReasoningEffortOptions("cursor")).toEqual([]);
  });
});

describe("getDefaultReasoningEffort", () => {
  it("returns provider-scoped defaults", () => {
    expect(getDefaultReasoningEffort("codex")).toBe(
      DEFAULT_REASONING_EFFORT_BY_PROVIDER.codex,
    );
    expect(getDefaultReasoningEffort("claudeCode")).toBe(
      DEFAULT_REASONING_EFFORT_BY_PROVIDER.claudeCode,
    );
    expect(getDefaultReasoningEffort("cursor")).toBe(
      DEFAULT_REASONING_EFFORT_BY_PROVIDER.cursor,
    );
  });
});
