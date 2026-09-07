import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { act, createElement, useEffect } from "react";
import { create } from "react-test-renderer";

import type { ShellThemeBootstrap } from "./shellThemeOverride";

function documentFixture(bootstrap: ShellThemeBootstrap = {}) {
  const variables = new Map<string, string>();
  const classes = new Set<string>();
  const storage = new Map<string, string>([["t3code:theme", "light"]]);
  const root = {
    dataset: {} as Record<string, string>,
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      toggle: (name: string, enabled: boolean) =>
        enabled ? classes.add(name) : classes.delete(name),
    },
    style: {
      backgroundColor: "",
      setProperty: (name: string, value: string) => variables.set(name, value),
      removeProperty: (name: string) => variables.delete(name),
    },
  };
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", {
    __t3ShellTheme: bootstrap,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return { root, variables, classes, storage, bootstrap };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const shell = {
  id: "shell-night",
  dark: true,
  vars: { "--app-theme-canvas": "#123456", "--boot-background": "#123456" },
};

describe("shell theme ownership", () => {
  it("lets embedded documents claim the override without publishing native colors", async () => {
    const disconnect = vi.fn();
    const fixture = documentFixture({ observer: { disconnect }, override: shell });
    const publish = vi.fn();
    vi.stubGlobal("window", { ...window, t3Shell: { publish } });
    const { ShellThemeBridge } = await import("./ShellThemeBridge");
    const renderer = await act(() =>
      create(createElement(ShellThemeBridge, { publishToShell: false })),
    );
    expect(fixture.root.dataset.themeId).toBe(shell.id);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    await act(() => renderer.unmount());
  });

  it("hands bootstrap ownership to the page and keeps the override over palettes and previews", async () => {
    const disconnect = vi.fn();
    const fixture = documentFixture({ observer: { disconnect }, override: shell });
    const { claimShellThemeOverride } = await import("./shellThemeOverride");
    const { applyThemePalette, applyThemeColorPreview, T3_CHAT_THEME } =
      await import("../themePalette");
    claimShellThemeOverride();
    claimShellThemeOverride();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(fixture.bootstrap.observer).toBeNull();
    for (const apply of [
      () => applyThemePalette("t3-chat", "light"),
      () => applyThemeColorPreview(T3_CHAT_THEME.colors, "light"),
      () => applyThemePalette("system"),
    ]) {
      apply();
      expect(fixture.root.dataset.themeId).toBe(shell.id);
      expect(fixture.classes.has("dark")).toBe(true);
      expect(fixture.variables.get("--app-theme-canvas")).toBe("#123456");
    }
    expect(fixture.storage.get("t3code:theme")).toBe("light");
  });

  it("accepts live replacement, removes stale variables, and releases unchanged stored preferences", async () => {
    const fixture = documentFixture({ override: shell });
    const { claimShellThemeOverride } = await import("./shellThemeOverride");
    const { useTheme } = await import("../hooks/useTheme");
    let theme!: ReturnType<typeof useTheme>;
    function Probe() {
      const value = useTheme();
      useEffect(() => {
        theme = value;
      }, [value]);
      return null;
    }
    const renderer = await act(() => create(createElement(Probe)));
    claimShellThemeOverride();
    await act(() => {
      theme.setTheme("light");
    });
    fixture.bootstrap.applyOverride?.({
      id: "shell-day",
      dark: false,
      vars: { "--app-theme-text": "#222222" },
    });
    expect(fixture.root.dataset.themeId).toBe("shell-day");
    expect(fixture.classes.has("dark")).toBe(false);
    expect(fixture.variables.has("--boot-background")).toBe(false);
    expect(fixture.variables.get("--app-theme-text")).toBe("#222222");
    fixture.bootstrap.applyOverride?.({ id: "", dark: false, vars: {} });
    await act(() => {
      theme.setTheme("light");
    });
    expect(fixture.root.dataset.themeId).toBeUndefined();
    expect(fixture.classes.has("dark")).toBe(false);
    expect(fixture.variables.has("--app-theme-text")).toBe(false);
    expect(fixture.storage.get("t3code:theme")).toBe("light");
    await act(() => renderer.unmount());
  });

  it("ignores identical publications without rewriting the document", async () => {
    const fixture = documentFixture({ override: shell });
    const { claimShellThemeOverride } = await import("./shellThemeOverride");
    const { subscribeToDocumentThemeOverride } = await import("../documentThemeOverride");
    const changed = vi.fn();
    const unsubscribe = subscribeToDocumentThemeOverride(changed);
    claimShellThemeOverride();
    const write = vi.spyOn(fixture.root.style, "setProperty");
    fixture.bootstrap.applyOverride?.(structuredClone(shell));
    expect(write).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("keeps older shells' observer when no override payload is available", async () => {
    const disconnect = vi.fn();
    const fixture = documentFixture({ observer: { disconnect } });
    const { claimShellThemeOverride } = await import("./shellThemeOverride");
    claimShellThemeOverride();
    expect(disconnect).not.toHaveBeenCalled();
    expect(fixture.bootstrap.applyOverride).toBeUndefined();
  });

  it("can claim before the native on-load injection", async () => {
    const fixture = documentFixture();
    const { claimShellThemeOverride } = await import("./shellThemeOverride");
    claimShellThemeOverride();
    fixture.bootstrap.applyOverride?.(shell);
    expect(fixture.root.dataset.themeId).toBe(shell.id);
  });
});
