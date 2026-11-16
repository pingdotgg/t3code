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

describe("theme backgrounds", () => {
  it("restores the selected background after its initial fetch fails and the network recovers", async () => {
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
    const image = new Blob(["image"], { type: "image/png" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockImplementation(async () => new Response(image)),
    );
    const stop = startThemeBackground();
    try {
      applyThemeBackground("nightfall");
      await vi.advanceTimersByTimeAsync(0);
      expect(properties.has("--theme-background-image")).toBe(false);

      browser.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(properties.get("--theme-background-image") ?? "").toMatch(/^url\("blob:/);
    } finally {
      stop();
      applyThemeBackground(undefined);
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it.each(["request failure", "HTTP 503", "online before rejection", "longer outage"])(
    "retries a temporary %s without needing a later online event",
    async (failure) => {
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
      const image = new Blob(["image"], { type: "image/png" });
      const fetchBackground = vi.fn().mockResolvedValue({ ok: true, blob: async () => image });
      fetchBackground.mockImplementationOnce(async () => {
        if (failure === "online before rejection") browser.dispatchEvent(new Event("online"));
        if (failure === "HTTP 503") return new Response(null, { status: 503 });
        throw new TypeError("Failed to fetch");
      });
      if (failure === "longer outage") {
        fetchBackground.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        fetchBackground.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        fetchBackground.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      }
      vi.stubGlobal("fetch", fetchBackground);
      const stop = startThemeBackground();
      try {
        applyThemeBackground("nightfall");
        await vi.advanceTimersByTimeAsync(0);
        expect(properties.has("--theme-background-image")).toBe(false);
        if (failure === "longer outage") {
          for (const [delay, attempts] of [
            [1_000, 1],
            [2_000, 2],
            [4_000, 3],
            [8_000, 4],
          ] as const) {
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(fetchBackground).toHaveBeenCalledTimes(attempts);
            expect(properties.has("--theme-background-image")).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
          }
        } else {
          await vi.advanceTimersByTimeAsync(30_000);
        }
        expect(properties.get("--theme-background-image") ?? "").toMatch(/^url\("blob:/);
        expect(fetchBackground).toHaveBeenCalledTimes(failure === "longer outage" ? 5 : 2);
      } finally {
        stop();
        applyThemeBackground(undefined);
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    },
  );

  it.each(["theme change", "disposal", "retry exhausted"])(
    "stops retrying after %s",
    async (reason) => {
      vi.useFakeTimers();
      const properties = new Map<string, string>();
      vi.stubGlobal("window", new EventTarget());
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
      const fetchBackground = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      vi.stubGlobal("fetch", fetchBackground);
      const stop = startThemeBackground();
      try {
        applyThemeBackground("nightfall");
        await vi.advanceTimersByTimeAsync(0);
        if (reason === "theme change") applyThemeBackground(undefined);
        if (reason === "disposal") stop();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetchBackground).toHaveBeenCalledTimes(reason === "retry exhausted" ? 5 : 1);
        expect(properties.has("--theme-background-image")).toBe(false);
      } finally {
        stop();
        applyThemeBackground(undefined);
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    },
  );
});
