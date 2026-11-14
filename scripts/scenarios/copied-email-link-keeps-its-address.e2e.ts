/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const MESSAGE = "Contact [Support](mailto:support@example.com?subject=Help) for help.";

test(
  "A copied message pastes its labelled email link with the address",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Support", messages: [MESSAGE] });
    await t3.open(thread);
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
