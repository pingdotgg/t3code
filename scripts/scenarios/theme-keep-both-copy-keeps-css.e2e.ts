import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const themeJson = (css?: string) =>
  JSON.stringify({
    version: 1,
    name: "Nyx",
    // The scenario browser is in light mode, and a one-appearance theme only fills that half.
    appearance: "light",
    colors: { canvas: "#f4f1ff", accent: "#6d5ae6" },
    ...(css ? { css } : {}),
  });

const NYX_CSS =
  ":root { --keep-both-marker: applied; } [data-settings-page-scroll] { outline: 8px solid #ff2d95; outline-offset: -8px; }";

test(
  "Keep both on a theme import conflict keeps the imported theme's CSS",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("demo");
    await t3.open("/settings/appearance");

    const importTheme = async (json: string) => {
      await screen.getByRole("button", "Add theme", { exact: true }).tap();
      const dialog = screen.getByRole("dialog", "Add a theme");
      await dialog.getByRole("textbox", "Theme JSON").fill(json);
      await dialog.getByRole("button", "Add theme", { exact: true }).tap();
      return dialog;
    };

    await expect(await importTheme(themeJson())).toBeHidden();

    const dialog = await importTheme(themeJson(NYX_CSS));
    await expect(dialog.getByText("Already installed")).toBeVisible();
    await dialog.getByRole("button", "Keep both").tap();
    await expect(dialog).toBeHidden();

    await screen.getByRole("button", "Use Nyx (1) theme").tap();
    await app.screenshot("keep-both-copy-selected");
    await expect
      .poll(() =>
        browser.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--keep-both-marker").trim(),
        ),
      )
      .toBe("applied");
  },
);
