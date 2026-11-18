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
    themeServerEnvironmentThemesAtom: Atom.make([{ id: "nightfall", scene: "revision-1" }]),
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

import { CUSTOM_THEMES_STORAGE_KEY, invalidateCustomThemes } from "./themePalette";
import { applyThemeScene } from "./themeScene";

type FakeFrame = {
  attributes: Map<string, string>;
  src: string;
  removed: boolean;
};

function setup(storage: Record<string, string> = {}) {
  const frames: Array<FakeFrame> = [];
  const dataset: Record<string, string> = {};
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => storage[key] ?? null } });
  invalidateCustomThemes();
  vi.stubGlobal("document", {
    documentElement: { dataset },
    body: { prepend: () => undefined },
    createElement: () => {
      const frame = {
        attributes: new Map<string, string>(),
        src: "",
        removed: false,
        tabIndex: 0,
        className: "",
        setAttribute: (name: string, value: string) => frame.attributes.set(name, value),
        addEventListener: () => undefined,
        remove: () => {
          frame.removed = true;
        },
      };
      frames.push(frame);
      return frame;
    },
  });
  query.mockReset();
  query.mockResolvedValue({ _tag: "Success", value: { relativeUrl: "/api/assets/t/scene.html" } });
  return {
    frames,
    dataset,
    [Symbol.dispose]() {
      applyThemeScene(undefined);
      vi.unstubAllGlobals();
      invalidateCustomThemes();
    },
  };
}

describe("theme scenes", () => {
  it("runs the published scene in a frame that cannot reach the app, and removes it", async () => {
    using t = setup();
    applyThemeScene("nightfall");
    await vi.waitFor(() => expect(t.frames).toHaveLength(1));
    const [frame] = t.frames;
    expect(frame?.attributes.get("sandbox")).toBe("allow-scripts");
    expect(frame?.src).toBe("https://example.com/api/assets/t/scene.html");
    expect(t.dataset.themeScene).toBe("");

    applyThemeScene(undefined);
    expect(frame?.removed).toBe(true);
    expect(t.dataset.themeScene).toBeUndefined();
  });

  it("does not run a published scene under a saved theme with the same id", async () => {
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
    applyThemeScene("nightfall");
    await Promise.resolve();
    expect(query).not.toHaveBeenCalled();
    expect(t.frames).toHaveLength(0);
  });
});
