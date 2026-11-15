import { expect } from "e2e";
import type { Browser } from "@e2e-dev/web";

import {
  expectHeldImageCompressions,
  finishNextImageCompression,
  holdImageCompression,
} from "./image-compression-hold.ts";
import { test, WEB } from "./t3.ts";

/** Copies a PNG over the 2000 px limit, so pasting it compresses; noise keeps it large. */
const copyWidePng = (browser: Browser, noise: boolean) =>
  browser.evaluate(async (noisy: boolean) => {
    const canvas = new OffscreenCanvas(2200, noisy ? 200 : 20);
    const context = canvas.getContext("2d")!;
    const pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 1;
    for (let index = 0; index < pixels.data.length; index++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels.data[index] = index % 4 === 3 ? 255 : noisy ? seed & 255 : 40;
    }
    context.putImageData(pixels, 0, 0);
    const png = await canvas.convertToBlob({ type: "image/png" });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return png.size;
  }, noise);

test(
  "An image pasted while an earlier pasted image prepares lands after it before a space in the prompt",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await holdImageCompression(browser);
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Screenshots", messages: ["first"] });
    await t3.open(thread);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();

    const composer = screen.getByRole("textbox");
    await composer.fill("Compare screenshots");
    await browser.keyboard.press("Home");
    for (let index = 0; index < "Compare".length; index++) {
      await browser.keyboard.press("ArrowRight");
    }
    await copyWidePng(browser, false);
    await browser.keyboard.press("ControlOrMeta+V");
    await expectHeldImageCompressions(browser, 1);
    await copyWidePng(browser, true);
    await browser.keyboard.press("ControlOrMeta+V");
    await expectHeldImageCompressions(browser, 2);

    await finishNextImageCompression(browser);
    await finishNextImageCompression(browser);
    const chips = composer.getByRole("button", "Image attachment", { exact: false });
    await expect(chips).toHaveCount(2);
    await app.screenshot("both-images-prepared");
    // The solid image, pasted first, is the 1 KB one.
    await expect(chips.first()).toHaveAccessibleName("Image attachment, image.png, 1 KB");
    await expect(chips.nth(1)).not.toHaveAccessibleName("Image attachment, image.png, 1 KB");
  },
);
