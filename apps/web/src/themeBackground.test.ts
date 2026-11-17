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

const BACKGROUND = "--theme-background-image";
const image = new Blob(["image"], { type: "image/png" });
const offline = () => Promise.reject(new TypeError("Failed to fetch"));
const loaded = async () => ({ ok: true, blob: async () => image });

function setup() {
  vi.useFakeTimers();
  const properties = new Map<string, string>();
  const browser = new EventTarget();
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", {
    documentElement: {
      dataset: { themeId: "nightfall" },
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
});
