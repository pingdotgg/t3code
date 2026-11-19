/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const CONTENT = String.raw`"Theme preview: \"ready\""`;

test(
  "A theme renders custom text containing quotation marks",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("demo");
    await t3.open("/settings/appearance");
    await screen.getByRole("button", "Add theme", { exact: true }).tap();
    const dialog = screen.getByRole("dialog", "Add a theme");
    await dialog.getByRole("textbox", "Theme JSON").fill(
      JSON.stringify({
        version: 1,
        name: "Quoted Preview",
        appearance: "light",
        colors: { canvas: "#ffffff", accent: "#734ee4" },
        css: `[data-settings-page-scroll]::before { display: block; content: ${CONTENT}; }`,
      }),
    );
    await dialog.getByRole("button", "Add theme", { exact: true }).tap();
    await dialog.waitFor({ state: "hidden" });
    await screen.getByRole("button", "Use Quoted Preview theme", { exact: true }).tap();

    try {
      await expect
        .poll(
          () =>
            browser.evaluate(() => {
              const settings = document.querySelector("[data-settings-page-scroll]");
              return settings ? getComputedStyle(settings, "::before").content : "";
            }),
          { message: "The selected theme displays its custom text with quotation marks" },
        )
        .toBe(CONTENT);
    } finally {
      await app.screenshot("theme-custom-text");
    }
  },
);
