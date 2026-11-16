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
});
