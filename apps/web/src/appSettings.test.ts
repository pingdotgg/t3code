import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_SETTINGS_STORAGE_KEY,
  getAppSettingsSnapshot,
  getAppModelOptions,
  getSlashModelOptions,
  normalizeCustomModelSlugs,
  resolveAppModelSelection,
} from "./appSettings";

function getWindowForTest(): Window & typeof globalThis {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis;
  };
  if (!testGlobal.window) {
    testGlobal.window = {} as Window & typeof globalThis;
  }
  return testGlobal.window;
}

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

beforeEach(() => {
  const testWindow = getWindowForTest();
  Object.defineProperty(testWindow, "localStorage", {
    configurable: true,
    value: createStorage(),
  });
  testWindow.addEventListener = vi.fn();
  testWindow.removeEventListener = vi.fn();
});

describe("getAppSettingsSnapshot", () => {
  it("includes newThreadUsesNewWorktree in the default settings", () => {
    expect(getAppSettingsSnapshot().newThreadUsesNewWorktree).toBe(false);
  });

  it("applies schema defaults when older persisted payloads omit new settings", () => {
    getWindowForTest().localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        confirmThreadDelete: false,
      }),
    );

    expect(getAppSettingsSnapshot()).toMatchObject({
      confirmThreadDelete: false,
      newThreadUsesNewWorktree: false,
    });
  });
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
