/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const MESSAGE = "Steps:\n\n1. Install\n2. Configure\n3. Deploy\n\nThen report back.";

test(
  "A copy that starts at a later list item and ends past the list keeps the shown numbers",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Steps", messages: [MESSAGE] });
    await t3.open(thread);
    // A message sent through the CLI shows collapsed under its sender.
    await screen.getByRole("button", /^Agent Steps/).tap();
    await expect(screen.getByText("Configure")).toBeVisible();

    // Drag from the second item's text to the end of the paragraph after the list.
    await browser.evaluate(() => {
      const body = document.querySelector("[data-user-message-body]");
      const item = [...(body?.querySelectorAll("li") ?? [])].find(
        (candidate) => candidate.textContent === "Configure",
      );
      const after = [...(body?.querySelectorAll("p") ?? [])].at(-1);
      if (!item?.firstChild || !after?.firstChild) throw new Error("No rendered list message");
      const range = document.createRange();
      range.setStart(item.firstChild, 0);
      range.setEnd(after.firstChild, after.firstChild.textContent?.length ?? 0);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      return null;
    });
    await browser.keyboard.press("ControlOrMeta+C");

    const composer = screen.getByRole("textbox");
    await composer.tap();
    await browser.keyboard.press("ControlOrMeta+V");
    // The composer parses the pasted Markdown, so its numbers become the list's start.
    const pastedList = browser.locator('[role="textbox"] ol');
    await expect(pastedList).toHaveText(/Configure\s*Deploy/);
    await app.screenshot("pasted");
    await expect(pastedList).toHaveAttribute("start", "2");
  },
);
