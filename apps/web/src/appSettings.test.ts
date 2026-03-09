import { describe, expect, it } from "vitest";

import {
  APP_DEFAULT_MODEL_AUTO,
  getAppModelOptions,
  getSlashModelOptions,
  normalizeAppDefaultModelSetting,
  normalizeCustomModelSlugs,
  resolveProjectDefaultModelForNewThread,
  resolveAppServiceTier,
  shouldShowFastTierIcon,
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

  it("treats auto as a reserved non-custom value", () => {
    expect(normalizeCustomModelSlugs(["auto", "AUTO", "custom/internal-model"])).toEqual([
      "custom/internal-model",
    ]);
  });
});

describe("normalizeAppDefaultModelSetting", () => {
  it("defaults to auto when blank or missing", () => {
    expect(normalizeAppDefaultModelSetting(undefined)).toBe(APP_DEFAULT_MODEL_AUTO);
    expect(normalizeAppDefaultModelSetting(" ")).toBe(APP_DEFAULT_MODEL_AUTO);
  });

  it("normalizes auto case and preserves model slugs", () => {
    expect(normalizeAppDefaultModelSetting(" AUTO ")).toBe(APP_DEFAULT_MODEL_AUTO);
    expect(normalizeAppDefaultModelSetting("gpt-5.3-codex")).toBe("gpt-5.3-codex");
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

  it("can omit selected-model injection for strict validation paths", () => {
    const options = getAppModelOptions("codex", [], "custom/selected-model", {
      includeSelectedModel: false,
    });

    expect(options.some((option) => option.slug === "custom/selected-model")).toBe(false);
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

  it("falls back to the provider default when unknown models are not preserved", () => {
    expect(
      resolveAppModelSelection("codex", [], "custom/deleted-model", {
        preserveUnknownSelectedModel: false,
      }),
    ).toBe("gpt-5.4");
  });
});

describe("resolveProjectDefaultModelForNewThread", () => {
  it("uses explicit default model setting when auto is not selected", () => {
    const resolved = resolveProjectDefaultModelForNewThread({
      projectId: "project-1",
      projectModel: "gpt-5.4",
      threads: [
        {
          projectId: "project-1",
          model: "gpt-5.2",
          createdAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      defaultModelSetting: "gpt-5.3-codex",
      customModels: [],
    });

    expect(resolved).toBe("gpt-5.3-codex");
  });

  it("picks the most-used model for a project when auto is enabled", () => {
    const resolved = resolveProjectDefaultModelForNewThread({
      projectId: "project-1",
      projectModel: "gpt-5.4",
      threads: [
        {
          projectId: "project-1",
          model: "gpt-5.3-codex",
          createdAt: "2026-03-01T00:00:00.000Z",
        },
        {
          projectId: "project-1",
          model: "gpt-5.2",
          createdAt: "2026-03-02T00:00:00.000Z",
        },
        {
          projectId: "project-1",
          model: "gpt-5.3-codex",
          createdAt: "2026-03-03T00:00:00.000Z",
        },
        {
          projectId: "project-2",
          model: "gpt-5.2",
          createdAt: "2026-03-04T00:00:00.000Z",
        },
      ],
      defaultModelSetting: APP_DEFAULT_MODEL_AUTO,
      customModels: [],
    });

    expect(resolved).toBe("gpt-5.3-codex");
  });
});

describe("getSlashModelOptions", () => {
  it("includes saved custom model slugs for /model command suggestions", () => {
    const options = getSlashModelOptions("codex", ["custom/internal-model"], "", "gpt-5.3-codex");

    expect(options.some((option) => option.slug === "custom/internal-model")).toBe(true);
  });

  it("filters slash-model suggestions across built-in and custom model names", () => {
    const options = getSlashModelOptions("codex", ["openai/gpt-oss-120b"], "oss", "gpt-5.3-codex");

    expect(options.map((option) => option.slug)).toEqual(["openai/gpt-oss-120b"]);
  });
});

describe("resolveAppServiceTier", () => {
  it("maps automatic to no override", () => {
    expect(resolveAppServiceTier("auto")).toBeNull();
  });

  it("preserves explicit service tier overrides", () => {
    expect(resolveAppServiceTier("fast")).toBe("fast");
    expect(resolveAppServiceTier("flex")).toBe("flex");
  });
});

describe("shouldShowFastTierIcon", () => {
  it("shows the fast-tier icon only for gpt-5.4 on fast tier", () => {
    expect(shouldShowFastTierIcon("gpt-5.4", "fast")).toBe(true);
    expect(shouldShowFastTierIcon("gpt-5.4", "auto")).toBe(false);
    expect(shouldShowFastTierIcon("gpt-5.3-codex", "fast")).toBe(false);
  });
});
