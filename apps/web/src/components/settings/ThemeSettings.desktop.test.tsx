// @vitest-environment jsdom
import type { DesktopBridge, DesktopLocalThemeState } from "@t3tools/contracts";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useEnvironmentTheme", () => ({
  useEnvironmentThemeDefinitions: () => [],
}));

import { applyDesktopThemeState } from "../../desktopTheme";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useTheme } from "../../hooks/useTheme";
import { DESKTOP_LOCAL_THEME_ID, getDesktopThemeState } from "../../themePalette";
import { ThemeLibrary } from "./ThemeSettings";

const native: DesktopLocalThemeState = {
  appearance: "dark",
  accent: "#6688aa",
  source: "native",
  filePath: null,
  status: "ready",
  theme: null,
};
const file: DesktopLocalThemeState = {
  ...native,
  source: "file",
  filePath: "/themes/current.json",
  theme: {
    name: "Personal palette",
    appearance: "dark",
    canvas: "#123456",
    accent: "#6688aa",
  },
};
const picker = vi.fn<() => Promise<string | null>>();
const saveSource = vi.fn<(path: string | null) => Promise<DesktopLocalThemeState>>();
let root: Root;
let container: HTMLDivElement;
let controls: ReturnType<typeof useTheme>;

function Harness() {
  const current = useTheme();
  useEffect(() => {
    controls = current;
  }, [current]);
  const customThemes = useCustomThemes();
  return (
    <ThemeLibrary
      {...current}
      initialAppearance={current.resolvedTheme}
      customThemes={customThemes}
      isImportOpen={false}
      onImportOpenChange={() => undefined}
    />
  );
}

function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(found, `Button "${label}" should be available`).toBeDefined();
  return found!;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  picker.mockReset().mockResolvedValue(null);
  saveSource.mockReset().mockResolvedValue(native);
  window.desktopBridge = {
    pickLocalThemeFile: picker,
    setLocalThemeFile: saveSource,
    setTheme: vi.fn().mockResolvedValue(undefined),
  } as unknown as DesktopBridge;
  applyDesktopThemeState(native);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  await act(async () => {
    controls.setTheme("grove");
    controls.setAppearanceMode("light");
    controls.refreshTheme();
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.unstubAllGlobals();
});

describe("desktop theme settings", () => {
  it("selects system colors and automatic appearance explicitly", async () => {
    expect(container.textContent).toContain("Native system colors");
    expect(controls.theme).toBe("grove");

    await click("System theme");

    expect(controls.theme).toBe(DESKTOP_LOCAL_THEME_ID);
    expect(controls.appearanceMode).toBe("system");
    expect(controls.resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.themeId).toBe(DESKTOP_LOCAL_THEME_ID);
  });

  it("leaves the source and manual theme untouched after picker cancellation", async () => {
    await click("Choose theme file");

    expect(picker).toHaveBeenCalledOnce();
    expect(saveSource).not.toHaveBeenCalled();
    expect(getDesktopThemeState()).toEqual(native);
    expect(controls.theme).toBe("grove");
    expect(button("Choose theme file").disabled).toBe(false);
  });

  it("updates the file source without selecting it over a manual theme", async () => {
    picker.mockResolvedValue(file.filePath);
    saveSource.mockResolvedValue(file);

    await click("Choose theme file");

    expect(saveSource).toHaveBeenCalledWith(file.filePath);
    expect(container.textContent).toContain(file.filePath);
    expect(container.textContent).toContain("Custom theme file");
    expect(controls.theme).toBe("grove");
    expect(controls.appearanceMode).toBe("light");
  });

  it("shows a source failure and keeps the current palette", async () => {
    picker.mockResolvedValue(file.filePath);
    saveSource.mockRejectedValue(new Error("Cannot save settings"));

    await click("Choose theme file");

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not change the theme source",
    );
    expect(getDesktopThemeState()).toEqual(native);
    expect(controls.theme).toBe("grove");
    expect(button("Choose theme file").disabled).toBe(false);
  });

  it("disables source changes while saving and leaves the manual theme active", async () => {
    let resolveSave!: (state: DesktopLocalThemeState) => void;
    picker.mockResolvedValue(file.filePath);
    saveSource.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    await click("Choose theme file");

    expect(button("Saving source…").disabled).toBe(true);
    expect(controls.theme).toBe("grove");
    await act(async () => resolveSave(file));
    expect(button("Change theme file").disabled).toBe(false);
    expect(controls.theme).toBe("grove");
  });

  it("returns to automatic colors while preserving the manual theme", async () => {
    await act(async () => applyDesktopThemeState(file));

    await click("Use automatic colors");

    expect(saveSource).toHaveBeenCalledWith(null);
    expect(container.textContent).toContain("Native system colors");
    expect(container.textContent).not.toContain(file.filePath);
    expect(controls.theme).toBe("grove");
    expect(controls.appearanceMode).toBe("light");
  });
});
