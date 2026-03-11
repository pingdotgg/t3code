import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAppSettingsSnapshot,
  getAppModelOptions,
  getSlashModelOptions,
  normalizeCustomModelSlugs,
  resolveAppModelSelection,
} from "./appSettings";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
  };
}

function writeSettings(partial: Record<string, unknown>) {
  localStorage.setItem(
    "t3code:app-settings:v1",
    JSON.stringify({
      codexBinaryPath: "",
      codexHomePath: "",
      confirmThreadDelete: true,
      enableAssistantStreaming: false,
      customCodexModels: [],
      ...partial,
    }),
  );
}

beforeEach(() => {
  const storage = createStorage();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", {
    localStorage: storage,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    const options = getSlashModelOptions("codex", ["custom/internal-model"], "", "gpt-5.3-codex");

    expect(options.some((option) => option.slug === "custom/internal-model")).toBe(true);
  });

  it("filters slash-model suggestions across built-in and custom model names", () => {
    const options = getSlashModelOptions("codex", ["openai/gpt-oss-120b"], "oss", "gpt-5.3-codex");

    expect(options.map((option) => option.slug)).toEqual(["openai/gpt-oss-120b"]);
  });
});

describe("getAppSettingsSnapshot", () => {
  it("defaults the thread environment mode to local for older persisted settings", () => {
    localStorage.setItem(
      "t3code:app-settings:v1",
      JSON.stringify({
        codexBinaryPath: "/usr/local/bin/codex",
        codexHomePath: "",
        confirmThreadDelete: true,
        enableAssistantStreaming: false,
        customCodexModels: [],
      }),
    );

    expect(getAppSettingsSnapshot().defaultThreadEnvMode).toBe("local");
  });

  it("falls back to local when the persisted thread environment mode is invalid", () => {
    writeSettings({
      defaultThreadEnvMode: "invalid",
    });

    expect(getAppSettingsSnapshot().defaultThreadEnvMode).toBe("local");
  });

  it("reads a persisted worktree default for new threads", () => {
    writeSettings({
      defaultThreadEnvMode: "worktree",
    });

    expect(getAppSettingsSnapshot().defaultThreadEnvMode).toBe("worktree");
  });
});
