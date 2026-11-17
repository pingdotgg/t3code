import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Importing light and dark theme files together keeps their shared custom CSS",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("demo");
    await t3.open("/settings/appearance");
    await screen.getByRole("button", "Add theme", { exact: true }).tap();
    const dialog = screen.getByRole("dialog", "Add a theme");
    await browser.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error("Theme file input is missing");
      const files = new DataTransfer();
      for (const appearance of ["light", "dark"] as const) {
        const theme = {
          version: 1,
          name: `Aurora ${appearance === "light" ? "Light" : "Dark"}`,
          appearance,
          colors: {
            canvas: appearance === "light" ? "#fafafa" : "#101014",
            accent: "#6d5ae6",
          },
          css: "[data-settings-page-scroll] { outline: 8px solid #ff2d95; outline-offset: -8px; }",
        };
        files.items.add(
          new File([JSON.stringify(theme)], `aurora-${appearance}.json`, {
            type: "application/json",
          }),
        );
      }
      input.files = files.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(dialog).toBeHidden();
    await screen.getByRole("button", "Use Aurora theme", { exact: true }).tap();
    await app.screenshot("paired-theme-custom-css");
    await expect
      .poll(() =>
        browser.evaluate(() => {
          const surface = document.querySelector("[data-settings-page-scroll]");
          if (!surface) throw new Error("Settings surface is missing");
          return getComputedStyle(surface).outlineWidth;
        }),
      )
      .toBe("8px");
  },
);
