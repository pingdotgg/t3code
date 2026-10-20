import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  removeCustomTheme,
  THEME_FILE_VERSION,
  themeColorToHex,
  updateCustomTheme,
  type ThemeDefinition,
} from "../../themePalette";

vi.mock(import("../../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () =>
    ({ theme: "system", themeHalves: null, setTheme: vi.fn(), refreshTheme: vi.fn() }) as never,
}));
// The real panel is a large lazy editor; this stand-in shows which theme the host hands it.
vi.mock(import("./ThemeEditorPanel"), async (original) => ({
  ...(await original()),
  ThemeEditorPanel: (({
    editingTheme,
    seedTheme,
  }: {
    editingTheme: ThemeDefinition | null;
    seedTheme: ThemeDefinition | null;
  }) => (
    <dl>
      <dt>editingTheme</dt>
      <dd>{editingTheme ? themeColorToHex(editingTheme.colors.accent ?? "") : "none"}</dd>
      <dt>seedTheme</dt>
      <dd>{seedTheme ? themeColorToHex(seedTheme.colors.accent ?? "") : "none"}</dd>
    </dl>
  )) as never,
}));

import { ThemeEditorHost } from "./ThemeEditorHost";
import { useThemeEditorStore } from "./themeEditorStore";

type Field = "editingTheme" | "seedTheme";

function install(id: string) {
  return installCustomTheme(
    parseThemeFile({
      version: THEME_FILE_VERSION,
      id,
      name: id,
      appearance: "dark",
      colors: { accent: "#1f6e4a" },
    }),
  );
}
function open(field: Field, themeId: string) {
  return act(async () =>
    useThemeEditorStore.getState().openThemeEditor({
      editingThemeId: field === "editingTheme" ? themeId : null,
      seedThemeId: field === "seedTheme" ? themeId : null,
      seedName: null,
      initialAppearance: "dark",
    }),
  );
}
async function shown(container: HTMLElement, field: Field) {
  await vi.waitFor(() => expect(container.querySelector("dl")).not.toBeNull(), {
    timeout: 5_000,
  });
  const terms = [...container.querySelectorAll("dt")];
  return terms.find((term) => term.textContent === field)?.nextElementSibling?.textContent;
}

async function setup() {
  await import("./ThemeEditorPanel");
  const storage = new Map(Object.entries(localStorage));
  const session = useThemeEditorStore.getState().session;
  localStorage.clear();
  invalidateCustomThemes();
  useThemeEditorStore.setState({ session: null });
  return {
    [Symbol.dispose]() {
      localStorage.clear();
      for (const [key, value] of storage) localStorage.setItem(key, value);
      invalidateCustomThemes();
      useThemeEditorStore.setState({ session });
    },
  };
}

describe("ThemeEditorHost", () => {
  it.each(["editingTheme", "seedTheme"] as const)(
    "reopens the same %s with its saved colors",
    async (field) => {
      using _state = await setup();
      await using screen = await render(<ThemeEditorHost />);
      const { container } = screen;
      const theme = install("saved-colors");
      await open(field, theme.id);
      expect(await shown(container, field)).toBe("#1f6e4a");

      await act(async () => useThemeEditorStore.getState().closeThemeEditor());
      expect(container.querySelector("dl")).toBeNull();
      updateCustomTheme({ ...theme, colors: { ...theme.colors, accent: "#7241b8" } });
      await open(field, theme.id);

      expect(await shown(container, field)).toBe("#7241b8");
    },
  );

  it.each(["editingTheme", "seedTheme"] as const)(
    "refreshes an open %s when the library changes",
    async (field) => {
      using _state = await setup();
      await using screen = await render(<ThemeEditorHost />);
      const { container } = screen;
      const theme = install("updated-theme");
      await open(field, theme.id);
      expect(await shown(container, field)).toBe("#1f6e4a");

      await act(async () =>
        updateCustomTheme({ ...theme, colors: { ...theme.colors, accent: "#7241b8" } }),
      );

      expect(await shown(container, field)).toBe("#7241b8");
    },
  );

  it("does not keep editing a theme removed from the library", async () => {
    using _state = await setup();
    await using screen = await render(<ThemeEditorHost />);
    const { container } = screen;
    const theme = install("removed-theme");
    await open("editingTheme", theme.id);
    expect(await shown(container, "editingTheme")).toBe("#1f6e4a");

    await act(async () => removeCustomTheme(theme.id));

    expect(await shown(container, "editingTheme")).toBe("none");
  });
});
