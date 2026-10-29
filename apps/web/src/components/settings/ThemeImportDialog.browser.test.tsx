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
