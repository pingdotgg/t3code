/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Typing after saving a citation puts a space between the quote and the new word",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Cite a response", messages: ["Start"] });
    await t3.open(thread);

    const composer = screen.getByTestId("composer-editor");
    await composer.fill("See world");
    await composer.press("End");
    for (const _ of "world") await composer.press("ArrowLeft");

    const source = browser.locator("[data-assistant-citation-source] p").first();
    await source.waitFor();
    await browser.evaluate(() => {
      const paragraph = document.querySelector("[data-assistant-citation-source] p");
      const text = paragraph?.firstChild;
      if (!paragraph || !text) throw new Error("The replayed assistant answer has no text");
      paragraph.scrollIntoView({ block: "center" });
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return null;
    });

    await screen.getByRole("button", "Cite selection in composer").tap();
    const comment = screen.getByRole("textbox", "Comment on selected text");
    await comment.fill("Check this quote");
    await comment.press("Enter");
    await comment.waitFor({ state: "detached" });
    await browser.keyboard.type("hello");

    const afterCitation = await browser.evaluate(() => {
      const chip = document.querySelector(
        '[data-testid="composer-editor"] [data-composer-citation-chip]',
      );
      const paragraph = chip?.closest("p");
      if (!chip || !paragraph) throw new Error("The saved citation is missing from the draft");
      const range = document.createRange();
      range.setStartAfter(chip);
      range.setEnd(paragraph, paragraph.childNodes.length);
      return range.toString().replaceAll("\u00a0", " ");
    });
    await app.screenshot("word-after-citation");
    expect(afterCitation).toBe(" hello world");
  },
);
