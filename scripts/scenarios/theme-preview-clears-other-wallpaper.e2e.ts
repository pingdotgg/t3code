import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const css = `[data-settings-page-scroll] {
  background-image: var(--theme-background-image, linear-gradient(#00ff00, #00ff00)) !important;
  background-size: cover !important;
}`;
const theme = (name: string) =>
  JSON.stringify({
    name,
    appearance: "light",
    canvas: "#f4f1ff",
    accent: "#6d5ae6",
    css,
  });

// A red pixel, stretched across the settings page by the published theme's CSS.
const wallpaper = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  ),
);

test(
  "A draft does not inherit another theme's published wallpaper",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const files = {
      "wallpaper-source.json": theme("Wallpaper Source"),
      "plain-draft.json": theme("Plain Draft"),
      "wallpaper-source.png": wallpaper,
    };
    const project = await t3.project("theme-preview", files);
    const themesDir = join(T3_HOME, "userdata", "themes");
    await mkdir(themesDir, { recursive: true });
    for (const name of Object.keys(files)) {
      await copyFile(join(project, name), join(themesDir, name));
    }
    await runPromise(makeState(T3_HOME).cli(["theme", "set", "wallpaper-source"]));
    await t3.open("/settings/appearance");

    await screen.getByRole("button", "Use Wallpaper Source theme", { exact: false }).tap();
    await expect
      .poll(() =>
        browser.evaluate(() =>
          getComputedStyle(
            document.querySelector("[data-settings-page-scroll]")!,
          ).backgroundImage.includes("blob:"),
        ),
      )
      .toBe(true);

    await screen.getByRole("button", "Duplicate Plain Draft", { exact: true }).tap();
    await expect
      .poll(() => browser.evaluate(() => document.documentElement.dataset.themeId))
      .toBe("__preview");
    await app.screenshot("draft-background");
    await expect
      .poll(() =>
        browser.evaluate(
          () =>
            getComputedStyle(document.querySelector("[data-settings-page-scroll]")!)
              .backgroundImage,
        ),
      )
      .toBe("linear-gradient(rgb(0, 255, 0), rgb(0, 255, 0))");
  },
);
