/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";

import { test, WEB } from "./lathe.ts";

const MESSAGE = "Contact [Support](mailto:support@example.com?subject=Help) for help.";

test(
  "A copied message pastes its labelled email link with the address",
  WEB,
  async ({ lathe, app, browser, screen }) => {
    const project = await lathe.project("demo");
    const thread = await lathe.thread({ project, title: "Support", messages: [MESSAGE] });
    await lathe.open(thread);
    // A message sent through the CLI shows collapsed under its sender.
    await screen.getByRole("button", /^Agent Contact/).tap();
    await expect(screen.getByRole("link", "Support")).toBeVisible();

    // Select the rendered paragraph as a drag across it would.
    await browser.evaluate(() => {
      const paragraph = document.querySelector('a[href^="mailto:"]')?.closest("p");
      if (!paragraph) throw new Error("No rendered email link");
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      return null;
    });
    await browser.keyboard.press("ControlOrMeta+C");

    const composer = screen.getByRole("textbox");
    await composer.tap();
    await browser.keyboard.press("ControlOrMeta+V");
    await app.screenshot("pasted");
    await expect(composer).toContainText(MESSAGE);
  },
);
