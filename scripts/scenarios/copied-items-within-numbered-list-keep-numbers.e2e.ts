/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Copying two items within a numbered list keeps their numbers",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({
      project,
      title: "Steps",
      messages: ["Steps:\n\n1. Install\n2. Configure\n3. Deploy\n\nThen report back."],
    });
    await t3.open(thread);
    await screen.getByRole("button", /^Agent Steps/).tap();
    await screen.getByText("Configure", { exact: true }).waitFor();

    await browser.evaluate(() => {
      const items = [...document.querySelectorAll("[data-user-message-body] ol > li")];
      const start = items.find((item) => item.textContent === "Configure")?.firstChild;
      const end = items.find((item) => item.textContent === "Deploy")?.firstChild;
      if (!start || !end) throw new Error("Could not find the two list items");
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.textContent?.length ?? 0);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return null;
    });
    await browser.keyboard.press("ControlOrMeta+C");
    await screen.getByRole("textbox").tap();
    await browser.keyboard.press("ControlOrMeta+V");

    const numberedItems = await browser.evaluate(() => {
      const list = document.querySelector<HTMLOListElement>('[role="textbox"] ol');
      if (!list) return null;
      return [...list.querySelectorAll(":scope > li")].map(
        (item, index) => `${list.start + index}. ${item.textContent?.trim()}`,
      );
    });
    await app.screenshot("pasted-list-items");
    expect(numberedItems, "The pasted items keep their displayed list numbers").toEqual([
      "2. Configure",
      "3. Deploy",
    ]);
  },
);
