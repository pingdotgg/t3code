import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Renaming same-named themes during a batch import preserves their CSS",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("demo");
    await t3.open("/settings/appearance");
    await screen.getByRole("button", "Add theme", { exact: true }).tap();

    await browser.evaluate(() => {
      const files = new DataTransfer();
      for (const name of ["nyx-one.json", "nyx-two.json"]) {
        files.items.add(
          new File(
            [
              JSON.stringify({
                version: 1,
                name: "Nyx",
                appearance: "light",
                colors: { canvas: "#f4f1ff", accent: "#6d5ae6" },
                css: "[data-settings-page-scroll] { outline: 8px solid #ff2d95; outline-offset: -8px; }",
              }),
            ],
            name,
            { type: "application/json" },
          ),
        );
      }
      const target = document.querySelector('input[type="file"]')?.parentElement;
      if (!target) throw new Error("No theme file drop target");
      target.dispatchEvent(
        new DragEvent("drop", { dataTransfer: files, bubbles: true, cancelable: true }),
      );
    });

    await screen.getByRole("button", "Use Nyx One theme").tap();
    await app.screenshot("renamed-batch-theme-selected");
    await expect
      .poll(() =>
        browser.evaluate(() => {
          const page = document.querySelector("[data-settings-page-scroll]");
          if (!page) throw new Error("No Appearance settings page");
          return getComputedStyle(page).outlineWidth;
        }),
      )
      .toBe("8px");
  },
);
