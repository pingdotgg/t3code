import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import {
  getThemeDefinition,
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  removeCustomTheme,
  THEME_FILE_VERSION,
  themeColorToHex,
  updateCustomTheme,
  type ThemeDefinition,
} from "../../themePalette";
import type { ThemeEditorSession } from "./themeEditorStore";

const state = vi.hoisted(() => ({
  session: null as ThemeEditorSession | null,
  closeThemeEditor: vi.fn(),
  onStoreChange: vi.fn(),
  subscriptions: new Set<() => void>(),
  theme: {
    theme: "system",
    themeHalves: null,
    setTheme: vi.fn(),
    refreshTheme: vi.fn(),
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useSyncExternalStore: (
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => unknown,
    ) => {
      const subscription = reactHookHarness.useRef<(() => void) | null>(null);
      if (!subscription.current) {
        subscription.current = subscribe(() => state.onStoreChange());
        state.subscriptions.add(subscription.current);
      }
      return getSnapshot();
    },
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../hooks/useTheme", () => ({ useTheme: () => state.theme }));
vi.mock("./themeEditorStore", () => ({
  useThemeEditorStore: (select: (store: typeof state) => unknown) => select(state),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));

import { ThemeEditorHost } from "./ThemeEditorHost";

function renderEditor() {
  hooks.beginRender();
  const host = ThemeEditorHost() as ReactElement<{
    children: ReactElement<{
      editingTheme: ThemeDefinition | null;
      seedTheme: ThemeDefinition | null;
    }>;
  }> | null;
  return host?.props.children.props ?? null;
}

describe("ThemeEditorHost", () => {
  beforeEach(() => {
    hooks.reset();
    state.session = null;
    state.onStoreChange.mockReset();
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    invalidateCustomThemes();
  });

  afterEach(() => {
    for (const unsubscribe of state.subscriptions) unsubscribe();
    state.subscriptions.clear();
    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it.each(["editingTheme", "seedTheme"] as const)(
    "reopens the same %s with its saved colors",
    (field) => {
      const theme = installCustomTheme(
        parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "saved-colors",
          name: "Saved colors",
          appearance: "dark",
          colors: { accent: "#1f6e4a" },
        }),
      );
      const session = {
        id: 1,
        editingThemeId: field === "editingTheme" ? theme.id : null,
        seedThemeId: field === "seedTheme" ? theme.id : null,
        seedName: null,
        initialAppearance: "dark" as const,
      };
      state.session = session;
      expect(themeColorToHex(renderEditor()?.[field]?.colors.accent ?? "")).toBe("#1f6e4a");

      updateCustomTheme({ ...theme, colors: { ...theme.colors, accent: "#7241b8" } });
      expect(themeColorToHex(getThemeDefinition(theme.id)?.colors.accent ?? "")).toBe("#7241b8");
      state.session = null;
      expect(renderEditor()).toBeNull();
      state.session = { ...session, id: 2 };

      expect(themeColorToHex(renderEditor()?.[field]?.colors.accent ?? "")).toBe("#7241b8");
    },
  );

  it.each(["editingTheme", "seedTheme"] as const)(
    "refreshes an open %s when the library changes",
    (field) => {
      const theme = installCustomTheme(
        parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "updated-theme",
          name: "Updated theme",
          appearance: "dark",
          colors: { accent: "#1f6e4a" },
        }),
      );
      state.session = {
        id: 1,
        editingThemeId: field === "editingTheme" ? theme.id : null,
        seedThemeId: field === "seedTheme" ? theme.id : null,
        seedName: null,
        initialAppearance: "dark",
      };
      let editor = renderEditor();
      state.onStoreChange.mockImplementation(() => {
        editor = renderEditor();
      });

      updateCustomTheme({ ...theme, colors: { ...theme.colors, accent: "#7241b8" } });

      expect(themeColorToHex(editor?.[field]?.colors.accent ?? "")).toBe("#7241b8");
    },
  );

  it("does not keep editing a theme removed from the library", () => {
    const theme = installCustomTheme(
      parseThemeFile({
        version: THEME_FILE_VERSION,
        id: "removed-theme",
        name: "Removed theme",
        appearance: "dark",
        colors: { accent: "#1f6e4a" },
      }),
    );
    state.session = {
      id: 1,
      editingThemeId: theme.id,
      seedThemeId: null,
      seedName: null,
      initialAppearance: "dark",
    };
    let editor = renderEditor();
    expect(editor?.editingTheme?.id).toBe(theme.id);
    state.onStoreChange.mockImplementation(() => {
      editor = renderEditor();
    });

    removeCustomTheme(theme.id);

    expect(editor?.editingTheme).toBeNull();
  });
});
