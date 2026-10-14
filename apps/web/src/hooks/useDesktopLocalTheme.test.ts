// @vitest-environment jsdom
import type { DesktopLocalThemeState } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDesktopLocalThemeSync } from "./useDesktopLocalTheme";
import { useDefaultThemeAdoption } from "./useDefaultTheme";
import { readThemeHalves, useTheme } from "./useTheme";
import {
  DESKTOP_LOCAL_THEME_ID,
  getDefaultThemeColors,
  getThemeColorVariable,
  applyThemeColorPreview,
  THEME_PREVIEW_ID,
} from "../themePalette";

const dark: DesktopLocalThemeState = {
  appearance: "dark",
  accent: "#abcdef",
  source: "file",
  filePath: "/themes/current.json",
  status: "ready",
  theme: { name: "Desktop", appearance: "dark", canvas: "#123456", accent: "#abcdef" },
};
const light: DesktopLocalThemeState = {
  ...dark,
  appearance: "light",
  theme: { ...dark.theme!, appearance: "light", canvas: "#f0e8d0" },
};
let root: Root | undefined;
let controls: ReturnType<typeof useTheme>;
let notify: (state: DesktopLocalThemeState) => void;
let resolveInitial: (state: DesktopLocalThemeState) => void;
const unsubscribe = vi.fn();
vi.mock("../state/server", () => ({ primaryServerSettingsAtom: "server-settings" }));
vi.mock("../state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: "environment" }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "server-settings"
      ? { defaultTheme: "iris", defaultThemeSetAt: "generation-one" }
      : "remote-environment",
}));
function DefaultAdoptionHarness() {
  useDefaultThemeAdoption();
  return createElement(Harness);
}

function Harness() {
  useDesktopLocalThemeSync();
  const current = useTheme();
  useEffect(() => {
    controls = current;
  }, [current]);
  return null;
}
async function mount(adoptDefault = false) {
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root!.render(createElement(adoptDefault ? DefaultAdoptionHarness : Harness)),
  );
}
async function setup(selected = true, deferred = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme-id");
  window.localStorage.setItem("t3code:theme", selected ? DESKTOP_LOCAL_THEME_ID : "iris");
  window.localStorage.setItem("t3code:theme-appearance-mode", "system");
  window.localStorage.setItem("draft", "unfinished message");
  const initial = deferred
    ? new Promise<DesktopLocalThemeState>((resolve) => {
        resolveInitial = resolve;
      })
    : Promise.resolve(dark);
  Object.assign(window, {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    desktopBridge: {
      getLocalTheme: () => initial,
      onLocalTheme: (listener: typeof notify) => {
        notify = listener;
        return unsubscribe;
      },
      setTheme: vi.fn().mockResolvedValue(undefined),
    },
  });
  controls?.refreshTheme();
  await mount();
  return new Map(Object.entries(window.localStorage));
}
async function publish(state: DesktopLocalThemeState) {
  await act(async () => notify(state));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  unsubscribe.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop theme selection", () => {
  it("follows the selected source without changing saved preferences or drafts", async () => {
    const saved = await setup();
    expect(document.documentElement.dataset.themeId).toBe(DESKTOP_LOCAL_THEME_ID);
    expect(controls.resolvedTheme).toBe("dark");
    await publish(light);
    expect(controls.resolvedTheme).toBe("light");
    expect(new Map(Object.entries(window.localStorage))).toEqual(saved);
  });
  it("keeps native discovery opt-in", async () => {
    await setup(false);
    expect(document.documentElement.dataset.themeId).toBe("iris");
    await publish(light);
    expect(document.documentElement.dataset.themeId).toBe("iris");
  });
  it("keeps a manual choice through updates and remounts", async () => {
    await setup();
    await act(async () => {
      controls.setTheme("iris");
    });
    await publish(light);
    expect(document.documentElement.dataset.themeId).toBe("iris");
    await act(async () => root!.unmount());
    await mount();
    expect(document.documentElement.dataset.themeId).toBe("iris");
  });
  it("keeps per-appearance assignments and reset readers literal", async () => {
    await setup();
    await act(async () => {
      controls.setThemeHalf("light", "grove");
      controls.setThemeHalf("dark", "iris");
    });
    expect(readThemeHalves()).toEqual({ light: "grove", dark: "iris" });
    expect(controls.resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.themeId).toBe("iris");
    await act(async () => {
      controls.setTheme("system");
      controls.clearThemeHalves();
    });
    expect(window.localStorage.getItem("t3code:theme-halves:v1")).toBeNull();
  });
  it("keeps a newer event over a delayed startup response", async () => {
    await setup(true, true);
    await publish(light);
    await act(async () => resolveInitial(dark));
    expect(controls.resolvedTheme).toBe("light");
  });
  it("does not let a delayed startup response change a manual selection", async () => {
    await setup(true, true);
    await act(async () => {
      controls.setTheme("grove");
    });
    await act(async () => resolveInitial(dark));
    expect(document.documentElement.dataset.themeId).toBe("grove");
  });
  it("does not replay a skipped server default after choosing a manual theme", async () => {
    await setup();
    await act(async () => root!.unmount());
    await mount(true);
    await act(async () => {
      controls.setTheme("grove");
    });
    expect(document.documentElement.dataset.themeId).toBe("grove");
  });
  it("preserves editor previews while caching the newest source", async () => {
    await setup();
    const colors = { ...getDefaultThemeColors("light"), canvas: "#fedcba" };
    applyThemeColorPreview(colors, "light");
    await publish(light);
    expect(document.documentElement.dataset.themeId).toBe(THEME_PREVIEW_ID);
    expect(document.documentElement.style.getPropertyValue(getThemeColorVariable("canvas"))).toBe(
      colors.canvas,
    );
    await act(async () => controls.refreshTheme());
    expect(document.documentElement.dataset.themeId).toBe(DESKTOP_LOCAL_THEME_ID);
    expect(controls.resolvedTheme).toBe("light");
  });
});
