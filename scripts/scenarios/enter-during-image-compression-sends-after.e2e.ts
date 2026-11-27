import { expect } from "e2e";

import {
  finishImageCompression,
  holdImageCompression,
  pasteWideScreenshot,
} from "./image-compression-hold.ts";
import { test, WEB } from "./t3.ts";

test(
  "Enter while a pasted image compresses sends the message with the image once it finishes",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await holdImageCompression(browser);
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Screenshot work", messages: ["first"] });
    await t3.open(thread);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();

    const composer = screen.getByRole("textbox");
    await composer.fill("What is in this screenshot?");
    await pasteWideScreenshot(browser);
    await browser.keyboard.press("Enter");
    await app.screenshot("enter-while-compressing");

    await finishImageCompression(browser);
    await app.screenshot("after-compression");
    const sentWithImage = browser
      .locator('[data-message-role="user"]:has([aria-label="Preview screenshot.png"])')
      .filter({ hasText: "What is in this screenshot?" });
    await expect(sentWithImage).toBeVisible();
    await expect(composer).not.toContainText("What is in this screenshot?");
    await expect(composer).not.toContainText("screenshot.png");
  },
);
