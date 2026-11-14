/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A copy that starts at a later list item and ends past the list keeps the shown numbers",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({
      project,
      title: "Steps",
      messages: ["Steps:\n\n1. Install\n2. Configure\n3. Deploy\n\nThen report back."],
    });
    await t3.open(thread);
    // A message sent through the CLI shows collapsed under its sender.
    await screen.getByRole("button", /^Agent Steps/).tap();
    await expect(screen.getByText("Configure")).toBeVisible();

    // Selects from a list item's text to the end of the paragraph after its list.
    await browser.evaluate(() => {
      const item = [...document.querySelectorAll("li")].find(
        (candidate) => candidate.textContent === "Configure",
      );
      const after = item?.closest("ol")?.nextElementSibling?.firstChild;
      if (!item?.firstChild || !after) throw new Error("No rendered list item Configure");
      const range = document.createRange();
      range.setStart(item.firstChild, 0);
      range.setEnd(after, after.textContent?.length ?? 0);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      return null;
    });
    await browser.keyboard.press("ControlOrMeta+C");
    await screen.getByRole("textbox").tap();
    await browser.keyboard.press("ControlOrMeta+V");

    // The composer parses the pasted Markdown, so the copied number becomes the list's start.
    const pasted = browser.locator('[role="textbox"] ol');
    await expect(pasted).toHaveText(/Configure\s*Deploy/);
    await app.screenshot("pasted");
    await expect(pasted).toHaveAttribute("start", "2");
  },
);
