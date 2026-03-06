import { describe, expect, it } from "vitest";

import { getAppModelOptions, getSlashModelOptions, normalizeCustomModelSlugs } from "./appSettings";

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

  it("normalizes provider-specific aliases for cursor", () => {
    expect(normalizeCustomModelSlugs(["composer"], "cursor")).toEqual([]);
    expect(normalizeCustomModelSlugs(["cursor/custom-model"], "cursor")).toEqual([
      "cursor/custom-model",
    ]);
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

  it("keeps a saved custom provider model available as an exact slug option", () => {
    const options = getAppModelOptions("cursor", ["cursor/custom-model"], "cursor/custom-model");

    expect(options.some((option) => option.slug === "cursor/custom-model" && option.isCustom)).toBe(
      true,
    );
  });
});

describe("getSlashModelOptions", () => {
  it("includes saved custom model slugs for /model command suggestions", () => {
    const options = getSlashModelOptions(
      "codex",
      ["custom/internal-model"],
      "",
      "gpt-5.3-codex",
    );

    expect(options.some((option) => option.slug === "custom/internal-model")).toBe(true);
  });

  it("filters slash-model suggestions across built-in and custom model names", () => {
    const options = getSlashModelOptions(
      "codex",
      ["openai/gpt-oss-120b"],
      "oss",
      "gpt-5.3-codex",
    );

    expect(options.map((option) => option.slug)).toEqual(["openai/gpt-oss-120b"]);
  });

  it("includes provider-specific custom slugs in non-codex model lists", () => {
    const cursorOptions = getAppModelOptions("cursor", ["cursor/custom-model"]);

    expect(cursorOptions.some((option) => option.slug === "cursor/custom-model")).toBe(true);
  });
});
