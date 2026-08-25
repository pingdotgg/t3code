import type { ReactElement } from "react";
import type { ThemeAppearance, ThemeDefinition, ThemeHalves, ThemeMode } from "../../themePalette";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const themeEditorStore = vi.hoisted(() => ({
  openThemeEditor: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  add: vi.fn(),
  stackedThreadToast: vi.fn(() => ({})),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("./themeEditorStore", () => ({
  useThemeEditorStore: (selector: (store: { openThemeEditor: unknown }) => unknown) =>
    selector(themeEditorStore),
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: toast.add },
  stackedThreadToast: toast.stackedThreadToast,
}));

// The Tooltip components use @base-ui/react Portal, which needs a real DOM.
// Replace them with pass-through stubs so the element tree stays inspectable.
vi.mock("../ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: unknown }) => children,
  Tooltip: ({ children }: { children: unknown }) => children,
  TooltipTrigger: ({ render }: { render: unknown }) => render,
  TooltipPopup: ({ children }: { children: unknown }) => children,
}));

import { ThemeLibrary } from "./ThemeSettings";

// Grove is the first maintainer theme with both light and dark modes.
const GROVE_THEME_ID = "grove";
const OCEAN_THEME_ID = "ocean";

function renderLibrary(overrides?: {
  readonly appearanceMode?: ThemeMode;
  readonly themeHalves?: ThemeHalves | null;
}): {
  element: ReactElement<Record<string, unknown>>;
  setAppearanceMode: ReturnType<typeof vi.fn>;
  setThemeHalf: ReturnType<typeof vi.fn>;
  setTheme: ReturnType<typeof vi.fn>;
} {
  const setAppearanceMode = vi.fn(() => true);
  const setThemeHalf = vi.fn(() => true);
  const setTheme = vi.fn(() => true);

  hooks.beginRender();
  const element = ThemeLibrary({
    theme: "system",
    setTheme,
    appearanceMode: overrides?.appearanceMode ?? "dark",
    setAppearanceMode,
    customThemes: [] as ReadonlyArray<ThemeDefinition>,
    initialAppearance: "dark" as ThemeAppearance,
    refreshTheme: vi.fn(),
    isImportOpen: false,
    onImportOpenChange: vi.fn(),
    themeHalves: overrides?.themeHalves ?? null,
    setThemeHalf,
  }) as ReactElement<Record<string, unknown>>;

  return { element, setAppearanceMode, setThemeHalf, setTheme };
}

function findCard(
  tree: ReactElement<Record<string, unknown>>,
  themeId: string,
): ReactElement<Record<string, unknown>> | null {
  return visitElements(tree, (el) => el.props.theme?.id === themeId);
}

describe("ThemeLibrary — assignHalf switches appearance mode", () => {
  beforeEach(() => {
    hooks.reset();
    themeEditorStore.openThemeEditor.mockReset();
    toast.add.mockReset();
  });

  it("switches to light mode when clicking light circle on a maintainer theme while in dark mode", () => {
    const { element, setAppearanceMode, setThemeHalf } = renderLibrary({
      appearanceMode: "dark",
    });
    const card = findCard(element, GROVE_THEME_ID);
    expect(card).not.toBeNull();

    (card!.props.onUseMode as (mode: ThemeMode) => void)("light");

    expect(setThemeHalf).toHaveBeenCalledWith("light", GROVE_THEME_ID);
    expect(setAppearanceMode).toHaveBeenCalledWith("light");
  });

  it("does not call setAppearanceMode when clicking dark circle while already in dark mode", () => {
    const { element, setAppearanceMode, setThemeHalf } = renderLibrary({
      appearanceMode: "dark",
    });
    const card = findCard(element, GROVE_THEME_ID);
    expect(card).not.toBeNull();

    (card!.props.onUseMode as (mode: ThemeMode) => void)("dark");

    expect(setThemeHalf).toHaveBeenCalledWith("dark", GROVE_THEME_ID);
    expect(setAppearanceMode).not.toHaveBeenCalled();
  });

  it("does not call setAppearanceMode when clicking light circle while already in light mode", () => {
    const { element, setAppearanceMode, setThemeHalf } = renderLibrary({
      appearanceMode: "light",
    });
    const card = findCard(element, GROVE_THEME_ID);
    expect(card).not.toBeNull();

    (card!.props.onUseMode as (mode: ThemeMode) => void)("light");

    expect(setThemeHalf).toHaveBeenCalledWith("light", GROVE_THEME_ID);
    expect(setAppearanceMode).not.toHaveBeenCalled();
  });

  it("switches to dark mode when clicking dark circle on a maintainer theme while in light mode", () => {
    const { element, setAppearanceMode, setThemeHalf } = renderLibrary({
      appearanceMode: "light",
    });
    const card = findCard(element, GROVE_THEME_ID);
    expect(card).not.toBeNull();

    (card!.props.onUseMode as (mode: ThemeMode) => void)("dark");

    expect(setThemeHalf).toHaveBeenCalledWith("dark", GROVE_THEME_ID);
    expect(setAppearanceMode).toHaveBeenCalledWith("dark");
  });

  it("does not call setAppearanceMode or setThemeHalf for system mode", () => {
    const { element, setAppearanceMode, setThemeHalf } = renderLibrary();
    const card = findCard(element, GROVE_THEME_ID);
    expect(card).not.toBeNull();

    (card!.props.onUseMode as (mode: ThemeMode) => void)("system");

    expect(setThemeHalf).not.toHaveBeenCalled();
    expect(setAppearanceMode).not.toHaveBeenCalled();
  });

  it("switches to light mode when clicking light circle on the default card while in dark mode", () => {
    const { element, setAppearanceMode, setThemeHalf } = renderLibrary({
      appearanceMode: "dark",
    });
    const defaultCard = findCard(element, "default");
    expect(defaultCard).not.toBeNull();

    (defaultCard!.props.onUseMode as (mode: ThemeMode) => void)("light");

    expect(setThemeHalf).toHaveBeenCalledWith("light", null);
    expect(setAppearanceMode).toHaveBeenCalledWith("light");
  });
});

describe("ThemeLibrary — pickedModesFor highlights only the current appearance mode", () => {
  beforeEach(() => {
    hooks.reset();
    themeEditorStore.openThemeEditor.mockReset();
    toast.add.mockReset();
  });

  it("highlights only the dark circle on the default card in dark mode with no halves", () => {
    const { element } = renderLibrary({ appearanceMode: "dark", themeHalves: null });
    const defaultCard = findCard(element, "default");
    expect(defaultCard).not.toBeNull();
    expect(defaultCard!.props.activeModes).toEqual(["dark"]);
  });

  it("highlights only the light circle on the default card in light mode with no halves", () => {
    const { element } = renderLibrary({ appearanceMode: "light", themeHalves: null });
    const defaultCard = findCard(element, "default");
    expect(defaultCard).not.toBeNull();
    expect(defaultCard!.props.activeModes).toEqual(["light"]);
  });

  it("highlights only the owning card's circle when a non-default theme owns the current mode", () => {
    const { element } = renderLibrary({
      appearanceMode: "light",
      themeHalves: { light: GROVE_THEME_ID },
    });
    const groveCard = findCard(element, GROVE_THEME_ID);
    expect(groveCard).not.toBeNull();
    expect(groveCard!.props.activeModes).toEqual(["light"]);

    const defaultCard = findCard(element, "default");
    expect(defaultCard).not.toBeNull();
    expect(defaultCard!.props.activeModes).toEqual([]);
  });

  it("does not highlight any card for the non-active mode", () => {
    const { element } = renderLibrary({
      appearanceMode: "dark",
      themeHalves: { light: GROVE_THEME_ID },
    });
    // Light mode is owned by Grove but we're in dark mode, so no card
    // should highlight light. Default owns dark.
    const groveCard = findCard(element, GROVE_THEME_ID);
    expect(groveCard).not.toBeNull();
    expect(groveCard!.props.activeModes).toEqual([]);

    const defaultCard = findCard(element, "default");
    expect(defaultCard).not.toBeNull();
    expect(defaultCard!.props.activeModes).toEqual(["dark"]);
  });

  it("highlights only one card when different themes own each mode", () => {
    const { element } = renderLibrary({
      appearanceMode: "light",
      themeHalves: { light: GROVE_THEME_ID, dark: OCEAN_THEME_ID },
    });
    const groveCard = findCard(element, GROVE_THEME_ID);
    expect(groveCard).not.toBeNull();
    expect(groveCard!.props.activeModes).toEqual(["light"]);

    const oceanCard = findCard(element, OCEAN_THEME_ID);
    expect(oceanCard).not.toBeNull();
    expect(oceanCard!.props.activeModes).toEqual([]);

    const defaultCard = findCard(element, "default");
    expect(defaultCard).not.toBeNull();
    expect(defaultCard!.props.activeModes).toEqual([]);
  });
});
