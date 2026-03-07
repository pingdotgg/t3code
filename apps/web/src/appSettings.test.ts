import { describe, expect, it } from "vitest";

import {
  clampTerminalFontSize,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_TERMINAL_LINE_HEIGHT,
  MAX_TERMINAL_LINE_HEIGHT,
  MIN_TERMINAL_LINE_HEIGHT,
  getAppModelOptions,
  getSlashModelOptions,
  normalizeCustomModelSlugs,
  parsePersistedSettings,
  resolveTerminalLineHeight,
  resolveTerminalFontFamily,
  resolveAppServiceTier,
  shouldShowFastTierIcon,
  resolveAppModelSelection,
} from "./appSettings";

function createPersistedSettings(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    codexBinaryPath: "",
    codexHomePath: "",
    confirmThreadDelete: true,
    enableAssistantStreaming: false,
    codexServiceTier: "auto",
    customCodexModels: [],
    terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
    terminalLineHeight: DEFAULT_TERMINAL_LINE_HEIGHT,
    ...overrides,
  });
}

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

describe("resolveTerminalFontFamily", () => {
  it("falls back to the default family for blank values", () => {
    expect(resolveTerminalFontFamily("   ")).toContain("monospace");
  });

  it("preserves non-empty values after trimming", () => {
    expect(resolveTerminalFontFamily("  Fira Code, monospace  ")).toBe("Fira Code, monospace");
  });
});

describe("clampTerminalFontSize", () => {
  it("clamps values to the supported terminal font size range", () => {
    expect(clampTerminalFontSize(5)).toBe(8);
    expect(clampTerminalFontSize(99)).toBe(32);
  });

  it("rounds valid values to whole pixels", () => {
    expect(clampTerminalFontSize(12.6)).toBe(13);
  });
});

describe("resolveTerminalLineHeight", () => {
  it("falls back to the default option for invalid values", () => {
    expect(resolveTerminalLineHeight(undefined)).toBe(DEFAULT_TERMINAL_LINE_HEIGHT);
  });

  it("clamps and rounds persisted values to the supported range", () => {
    expect(resolveTerminalLineHeight(0.8)).toBe(MIN_TERMINAL_LINE_HEIGHT);
    expect(resolveTerminalLineHeight(2.4)).toBe(MAX_TERMINAL_LINE_HEIGHT);
    expect(resolveTerminalLineHeight(1.236)).toBe(1.24);
  });
});

describe("parsePersistedSettings", () => {
  it("clamps persisted terminal font sizes instead of discarding the settings payload", () => {
    expect(
      parsePersistedSettings(
        createPersistedSettings({
          confirmThreadDelete: false,
          terminalFontFamily: "Fira Code, monospace",
          terminalFontSize: 99,
          terminalLineHeight: 2.4,
        }),
      ),
    ).toMatchObject({
      confirmThreadDelete: false,
      terminalFontFamily: "Fira Code, monospace",
      terminalFontSize: 32,
      terminalLineHeight: 2,
    });
  });

  it("accepts fractional persisted terminal font sizes and rounds them", () => {
    expect(
      parsePersistedSettings(
        createPersistedSettings({
          terminalFontSize: 12.6,
        }),
      ).terminalFontSize,
    ).toBe(13);
  });
});
