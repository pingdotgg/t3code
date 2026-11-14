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
      model: "ordered-list",
    });
    await t3.open(thread);
    // A message sent through the CLI shows collapsed under its sender.
    await screen.getByRole("button", /^Agent Steps/).tap();
    await expect(screen.getByText("Configure")).toBeVisible();
    await expect(screen.getByText("Verify")).toBeVisible();

    const composer = screen.getByRole("textbox");
    // Drags from a list item's text to the end of the paragraph after its list, then pastes.
    const pasteTailFrom = async (itemText: string) => {
      await browser.evaluate((text: string) => {
        const item = [...document.querySelectorAll("li")].find(
          (candidate) => candidate.textContent === text,
        );
        const after = item?.closest("ol")?.nextElementSibling?.firstChild;
        if (!item?.firstChild || !after) throw new Error(`No rendered list item ${text}`);
        const range = document.createRange();
        range.setStart(item.firstChild, 0);
        range.setEnd(after, after.textContent?.length ?? 0);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        return null;
      }, itemText);
      await browser.keyboard.press("ControlOrMeta+C");
      await composer.tap();
      await browser.keyboard.press("ControlOrMeta+End");
      await browser.keyboard.press("ControlOrMeta+V");
    };
    await pasteTailFrom("Configure");
    await pasteTailFrom("Verify");

    // The composer parses the pasted Markdown, so the copied numbers become each list's start.
    const [fromUser, fromAssistant] = [0, 1].map((index) =>
      browser.locator('[role="textbox"] ol').nth(index),
    );
    await expect(fromUser).toHaveText(/Configure\s*Deploy/);
    await expect(fromAssistant).toHaveText(/Verify\s*Ship/);
    await app.screenshot("pasted");
    await expect(fromUser).toHaveAttribute("start", "2");
    await expect(fromAssistant).toHaveAttribute("start", "2");
  },
);
