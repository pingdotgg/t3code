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
import { ThemeImportDialog } from "./ThemeImportDialog";

const theme = (name: string, accent = "#3b82f6") => ({
  version: THEME_FILE_VERSION,
  name,
  appearance: "dark",
  colors: { accent },
});

const themeFile = (name: string, accent?: string) =>
  new File([JSON.stringify(theme(name, accent))], `${name}.json`, { type: "application/json" });

describe("ThemeImportDialog", () => {
  const uploadBatchWithConflictAndFailure = async () => {
    await using stack = new AsyncDisposableStack();
    stack.defer(() => {
      window.localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
      invalidateCustomThemes();
    });
    installCustomTheme(parseThemeFile(theme("Dusk")));
    const onOpenChange = vi.fn();
    stack.use(
      await render(
        <ThemeImportDialog
          open
          onOpenChange={onOpenChange}
          onImported={() => true}
          onImportedMany={() => {}}
        />,
      ),
    );

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, [
      themeFile("Dawn"),
      themeFile("Dusk", "#f97316"),
      new File(["{"], "broken.json", { type: "application/json" }),
    ]);

    await expect.element(page.getByText("Already installed")).toBeVisible();
    await expect.element(page.getByText(/^broken\.json:/)).toBeVisible();
    return { onOpenChange, cleanup: stack.move() };
  };

  it("lets the user update an installed theme when another file in the batch fails", async () => {
    const { onOpenChange, cleanup } = await uploadBatchWithConflictAndFailure();
    await using _cleanup = cleanup;
    expect(getCustomThemes().map((theme) => theme.label)).toContain("Dawn");

    await page.getByRole("button", { name: "Update existing" }).click();
    invalidateCustomThemes();
    expect(getCustomThemes().find((theme) => theme.label === "Dusk")?.colors).toEqual(
      parseThemeFile(theme("Dusk", "#f97316")).colors,
    );
    await expect.element(page.getByText(/^broken\.json:/)).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("keeps a batch file failure visible after keeping both copies", async () => {
    const { onOpenChange, cleanup } = await uploadBatchWithConflictAndFailure();
    await using _cleanup = cleanup;

    await page.getByRole("button", { name: "Keep both" }).click();
    invalidateCustomThemes();
    expect(getCustomThemes().map((theme) => theme.label)).toContain("Dusk (1)");
    await expect.element(page.getByText(/^broken\.json:/)).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
