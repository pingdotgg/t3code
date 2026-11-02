import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  themeColorToHex,
  THEME_FILE_VERSION,
} from "../../themePalette";
import type { OpenVsxThemeExtension } from "../../openVsxThemes";
import { ThemeImportDialog } from "./ThemeImportDialog";

const searchOpenVsxThemes = vi.hoisted(() => vi.fn());

vi.mock("../../openVsxThemes", () => ({
  searchOpenVsxThemes,
  importOpenVsxThemeExtension: vi.fn(),
}));

const extension: OpenVsxThemeExtension = {
  id: "acme.nightfall",
  collectionId: "acme.nightfall",
  name: "Nightfall",
  publisher: "acme",
  description: "A dark theme",
  downloadCount: 10,
  iconUrl: null,
  sourceUrl: null,
  manifestUrl: "https://example.test/manifest",
  sha256Url: "https://example.test/sha256",
  vsixUrl: "https://example.test/vsix",
  version: "1.0.0",
  license: "MIT",
};

describe("ThemeImportDialog", () => {
  // StrictMode replays ref attach/detach on mount, which must not end the session.
  it("searches Open VSX under StrictMode", async () => {
    searchOpenVsxThemes.mockReset();
    searchOpenVsxThemes.mockResolvedValue([extension]);
    await using _screen = await render(
      <StrictMode>
        <ThemeImportDialog
          open
          onOpenChange={() => {}}
          onImported={() => true}
          onImportedMany={() => {}}
        />
      </StrictMode>,
    );

    await userEvent.type(page.getByLabelText("Search Open VSX themes"), "night");

    await expect.element(page.getByRole("heading", { name: "Nightfall" })).toBeVisible();
    expect(searchOpenVsxThemes).toHaveBeenCalledWith(
      "night",
      expect.objectContaining({ sortBy: "downloadCount" }),
    );
  });
});

const theme = (name: string, accent = "#3b82f6") => ({
  version: THEME_FILE_VERSION,
  name,
  appearance: "dark",
  colors: { accent },
});

const themeFile = (name: string, accent?: string) =>
  new File([JSON.stringify(theme(name, accent))], `${name}.json`, { type: "application/json" });

it.each(["Update existing", "Keep both"])(
  "keeps batch failures visible after %s",
  async (choice) => {
    using _themes = {
      [Symbol.dispose]() {
        window.localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
        invalidateCustomThemes();
      },
    };
    installCustomTheme(parseThemeFile(theme("Dusk")));
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={onOpenChange}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, [
      themeFile("Dawn"),
      themeFile("Dusk", "#f97316"),
      new File(["{"], "broken.json", { type: "application/json" }),
    ]);

    await expect.element(page.getByText("Already installed")).toBeVisible();
    await expect.element(page.getByText(/^broken\.json:/)).toBeVisible();
    expect(getCustomThemes().map((theme) => theme.label)).toContain("Dawn");
    await page.getByRole("button", { name: choice }).click();
    invalidateCustomThemes();
    const label = choice === "Update existing" ? "Dusk" : "Dusk (1)";
    expect(getCustomThemes().find((theme) => theme.label === label)?.colors).toEqual(
      parseThemeFile(theme("Dusk", "#f97316")).colors,
    );
    await expect.element(page.getByText(/^broken\.json:/)).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  },
);

function isolateThemes() {
  const previous = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
  localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
  invalidateCustomThemes();
  return {
    [Symbol.dispose]() {
      if (previous === null) localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
      else localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, previous);
      invalidateCustomThemes();
    },
  };
}

function themeJsonc(name: string, background: string) {
  return `{
    // VS Code themes use JSONC even with a .json extension.
    "name": "${name}",
    "colors": {
      "editor.background": "${background}",
    },
    "tokenColors": [],
  }`;
}

describe("ThemeImportDialog JSONC imports", () => {
  it.each(["paste", "file"])("imports a VS Code JSONC theme from %s", async (source) => {
    using _themes = isolateThemes();
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={() => {}}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    const json = themeJsonc("JSONC Night", "#002b36");
    if (source === "paste") {
      await page.getByRole("textbox", { name: "Theme JSON" }).fill(json);
    } else {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      await userEvent.upload(input, new File([json], "night.json", { type: "application/json" }));
      await expect.element(page.getByRole("textbox", { name: "Theme JSON" })).toHaveValue(json);
    }
    await page.getByRole("button", { name: "Add theme", exact: true }).click();

    expect(getCustomThemes().map((theme) => theme.label)).toEqual(["JSONC Night"]);
    expect(themeColorToHex(getCustomThemes()[0]!.colors.canvas)).toBe("#002b36");
  });

  it("imports each VS Code JSONC theme in a file batch", async () => {
    using _themes = isolateThemes();
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={() => {}}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, [
      new File([themeJsonc("JSONC Night", "#002b36")], "night.json", {
        type: "application/json",
      }),
      new File([themeJsonc("JSONC Day", "#fdf6e3")], "day.json", {
        type: "application/json",
      }),
    ]);

    await vi.waitFor(() => {
      expect(getCustomThemes().map((theme) => theme.label)).toEqual(["JSONC Night", "JSONC Day"]);
    });
    expect(getCustomThemes().map((theme) => themeColorToHex(theme.colors.canvas))).toEqual([
      "#002b36",
      "#fdf6e3",
    ]);
  });
});
