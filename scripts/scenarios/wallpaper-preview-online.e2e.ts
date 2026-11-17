// @effect-diagnostics nodeBuiltinImport:off - the scenario seeds a published wallpaper in its isolated home.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const WALLPAPER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGNgWLCFwTuPAYQXbAEAGoAEG4ysH8kAAAAASUVORK5CYII=",
  "base64",
);

const THEME = JSON.stringify({
  version: 1,
  name: "Wallpaper Preview",
  appearance: "light",
  canvas: "#f4f1ff",
  accent: "#6d5ae6",
  css: "[data-settings-page-scroll] { background-image: var(--theme-background-image); background-size: cover; }",
});

test(
  "A wallpaper stays visible in the theme preview when the browser comes back online",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo", {
      "wallpaper-preview.json": THEME,
      "wallpaper-preview.png": WALLPAPER,
    });
    const themesDir = NodePath.join(T3_HOME, "userdata", "themes");
    const imagePath = NodePath.join(themesDir, "wallpaper-preview.png");
    const themePath = NodePath.join(themesDir, "wallpaper-preview.json");
    const { cli } = makeState(T3_HOME);
    await NodeFSP.mkdir(themesDir, { recursive: true });
    await NodeFSP.copyFile(NodePath.join(project, "wallpaper-preview.png"), imagePath);
    try {
      await runPromise(cli(["theme", "set", NodePath.join(project, "wallpaper-preview.json")]));
      await t3.open("/settings/appearance");
      await screen.getByRole("button", "Use light mode", { exact: true }).tap();
      await screen.getByRole("button", "Use Wallpaper Preview theme", { exact: true }).tap();

      const background = () =>
        browser.evaluate(() => {
          const surface = document.querySelector("[data-settings-page-scroll]");
          return surface ? getComputedStyle(surface).backgroundImage : "missing settings surface";
        });
      await expect.poll(background).toContain("blob:");
      await screen.getByRole("button", "Duplicate Wallpaper Preview", { exact: true }).tap();
      await expect(screen.getByRole("dialog", "Create theme")).toBeVisible();
      await expect.poll(background).toContain("blob:");
      await app.screenshot("wallpaper-preview-before-online");

      // Reproduce the browser event delivered when connectivity returns, without navigating away.
      await browser.evaluate(() => window.dispatchEvent(new Event("online")));
      await app.screenshot("wallpaper-preview-after-online");
      await expect.poll(background).toContain("blob:");
    } finally {
      await NodeFSP.rm(themePath, { force: true });
      await NodeFSP.rm(imagePath, { force: true });
    }
  },
);
