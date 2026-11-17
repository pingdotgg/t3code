import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const query = vi.hoisted(() => vi.fn());
vi.mock(
  import("@t3tools/client-runtime/state/runtime"),
  () =>
    ({
      executeAtomQuery: query,
    }) as never,
);
vi.mock(import("./state/primaryEnvironment"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { themeEnvironmentIdAtom: Atom.make(EnvironmentId.make("host")) } as never;
});
vi.mock(import("./state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    themeServerEnvironmentThemesAtom: Atom.make([{ id: "nightfall", background: "revision-1" }]),
  } as never;
});
vi.mock(import("./state/session"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentSession: {
      preparedConnectionValueAtom: Atom.family(() =>
        Atom.make({ _tag: "Some", value: { httpBaseUrl: "https://example.com/" } }),
      ),
    },
  } as never;
});
vi.mock(
  import("./state/assets"),
  () =>
    ({
      assetEnvironment: { createUrl: vi.fn() },
    }) as never,
);

import { applyThemeBackground, startThemeBackground } from "./themeBackground";
import {
  applyThemeColorPreview,
  CUSTOM_THEMES_STORAGE_KEY,
  getThemeDefinition,
  invalidateCustomThemes,
} from "./themePalette";

const BACKGROUND = "--theme-background-image";
const image = new Blob(["image"], { type: "image/png" });
const offline = () => Promise.reject(new TypeError("Failed to fetch"));
const loaded = async () => ({ ok: true, blob: async () => image });

function setup(storage: Record<string, string> = {}) {
  vi.useFakeTimers();
  const properties = new Map<string, string>();
  const browser = Object.assign(new EventTarget(), {
    localStorage: { getItem: (key: string) => storage[key] ?? null },
  });
  vi.stubGlobal("window", browser);
  invalidateCustomThemes();
  vi.stubGlobal("document", {
    documentElement: {
      dataset: { themeId: "nightfall" },
      classList: { toggle: () => {} },
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    },
  });
  query.mockResolvedValue({ _tag: "Success", value: { relativeUrl: "/background.png" } });
  const fetchBackground = vi.fn<() => Promise<unknown>>(offline);
  vi.stubGlobal("fetch", fetchBackground);
  const stop = startThemeBackground();
  return {
    properties,
    browser,
    fetchBackground,
    stop,
    [Symbol.dispose]() {
      stop();
      applyThemeBackground(undefined);
      vi.unstubAllGlobals();
      invalidateCustomThemes();
      vi.useRealTimers();
    },
  };
}

describe("theme backgrounds", () => {
  it("retries a failed download after 1, 2, 4 and 8 seconds", async () => {
    using t = setup();
    t.fetchBackground
      .mockImplementationOnce(async () => new Response(null, { status: 503 }))
      .mockImplementationOnce(offline)
      .mockImplementationOnce(offline)
      .mockImplementationOnce(offline)
      .mockImplementation(loaded);

    applyThemeBackground("nightfall");
    await vi.advanceTimersByTimeAsync(0);
    for (const [delay, attempts] of [
      [1_000, 1],
      [2_000, 2],
      [4_000, 3],
      [8_000, 4],
    ] as const) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(t.fetchBackground).toHaveBeenCalledTimes(attempts);
      expect(t.properties.has(BACKGROUND)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(t.fetchBackground).toHaveBeenCalledTimes(5);
    expect(t.properties.get(BACKGROUND)).toMatch(/^url\("blob:/);
  });

  it("loads the background once when the browser comes back online after retries stop", async () => {
    using t = setup();
    applyThemeBackground("nightfall");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.fetchBackground).toHaveBeenCalledTimes(5);
    expect(t.properties.has(BACKGROUND)).toBe(false);

    t.fetchBackground.mockImplementation(loaded);
    t.browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.properties.get(BACKGROUND)).toMatch(/^url\("blob:/);

    t.browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.fetchBackground).toHaveBeenCalledTimes(6);
  });

  it.each(["theme change", "disposal"])("stops retrying after %s", async (reason) => {
    using t = setup();
    applyThemeBackground("nightfall");
    await vi.advanceTimersByTimeAsync(0);
    if (reason === "theme change") applyThemeBackground(undefined);
    else t.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.fetchBackground).toHaveBeenCalledTimes(1);
  });

  it("shows no published background when a saved theme shares its id", async () => {
    using t = setup({
      [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
        {
          id: "nightfall",
          label: "Nightfall",
          appearance: "dark",
          colors: { canvas: "#162327", accent: "#cc3344" },
        },
      ]),
    });
    t.fetchBackground.mockImplementation(loaded);
    expect(getThemeDefinition("nightfall")?.colors.accent).toBeDefined();
    applyThemeBackground("nightfall");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fetchBackground).not.toHaveBeenCalled();
    expect(t.properties.has(BACKGROUND)).toBe(false);
  });

  it("shows no published background under a theme draft", async () => {
    using t = setup();
    t.fetchBackground.mockImplementation(loaded);
    applyThemeBackground("nightfall");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.properties.get(BACKGROUND)).toMatch(/^url\("blob:/);

    applyThemeColorPreview({ canvas: "#f4f1ff", accent: "#6d5ae6" }, "light");
    expect(t.properties.has(BACKGROUND)).toBe(false);
  });
});
