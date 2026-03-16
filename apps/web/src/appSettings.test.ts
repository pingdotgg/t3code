import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIMESTAMP_FORMAT,
  DEFAULT_APP_SETTINGS,
  getAppModelOptions,
  normalizeCustomModelSlugs,
  resolveAppModelSelection,
} from "./appSettings";

describe("normalizeCustomModelSlugs", () => {
  it("normalizes aliases, removes built-ins, and deduplicates values", () => {
    expect(
      normalizeCustomModelSlugs([
        " custom/internal-model ",
        "gpt-5.3-codex",
        "5.3",
        "custom/internal-model",
        "",
        null,
      ]),
    ).toEqual(["custom/internal-model"]);
  });
});

describe("getAppModelOptions", () => {
  it("appends saved custom models after the built-in options", () => {
    const options = getAppModelOptions("codex", ["custom/internal-model"]);

    expect(options.map((option) => option.slug)).toEqual([
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.2",
      "custom/internal-model",
    ]);
  });

  it("keeps the currently selected custom model available even if it is no longer saved", () => {
    const options = getAppModelOptions("codex", [], "custom/selected-model");

    expect(options.at(-1)).toEqual({
      slug: "custom/selected-model",
      name: "custom/selected-model",
      isCustom: true,
    });
  });

  it("supports Claude built-ins and saved custom models", () => {
    const options = getAppModelOptions("claudeCode", ["claude-internal-preview"]);

    expect(options.map((option) => option.slug)).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-internal-preview",
    ]);
  });
});

describe("resolveAppModelSelection", () => {
  it("preserves saved custom model slugs instead of falling back to the default", () => {
    expect(resolveAppModelSelection("codex", ["galapagos-alpha"], "galapagos-alpha")).toBe(
      "galapagos-alpha",
    );
  });

  it("falls back to the provider default when no model is selected", () => {
    expect(resolveAppModelSelection("codex", [], "")).toBe("gpt-5.4");
  });

  it("preserves Claude custom model slugs instead of falling back", () => {
    expect(
      resolveAppModelSelection("claudeCode", ["claude-sonnet-internal"], "claude-sonnet-internal"),
    ).toBe("claude-sonnet-internal");
  });
});

describe("timestamp format defaults", () => {
  it("defaults timestamp format to locale", () => {
    expect(DEFAULT_TIMESTAMP_FORMAT).toBe("locale");
  });
});

describe("Claude teams defaults", () => {
  it("defaults Claude agent teams settings to disabled", () => {
    expect(DEFAULT_APP_SETTINGS.claudeExperimentalAgentTeams).toBe(false);
    expect(DEFAULT_APP_SETTINGS.claudeAgentProgressSummaries).toBe(false);
  });
});
