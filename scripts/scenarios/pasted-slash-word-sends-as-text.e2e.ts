/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

// A terminal copy ends in the agent CLI's status line, here a slash command.
const PASTED = "Here's the section as it would go into the report.\n\nBrewed for 1m 17s\n/model";

test(
  "Pasted text ending in a slash command sends as text instead of picking from the menu",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Paste", messages: ["hello"] });
    await t3.open(thread);

    const composer = screen.getByRole("textbox");
    await composer.tap();
    await browser.evaluate((text) => {
      const editor = document.querySelector('[data-testid="composer-editor"]');
      if (!editor) throw new Error("No composer editor");
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      editor.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      return null;
    }, PASTED);
    await expect(composer).toContainText("Brewed for 1m 17s");
    await app.screenshot("pasted");

    await browser.keyboard.press("Enter");
    await expect(screen.getByText("second fixture turn complete")).toBeVisible();
    await app.screenshot("sent");
  },
);
