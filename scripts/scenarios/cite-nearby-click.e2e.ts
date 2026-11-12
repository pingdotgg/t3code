/// <reference lib="dom" />

import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const SELECTED = "Reads the manifest first";

test(
  "A click just past where a selection drag ended does not cite the selection",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("demo", { "src/math.ts": "export const sum = 1 + 1;\n" });
    await t3.open();

    await screen.getByRole("textbox").fill("Give me a short tour");
    await screen.getByRole("textbox").press("Enter");
    await expect(screen.getByText("This turn is a replay.", { exact: false })).toBeVisible();

    const line = await browser.evaluate((text: string) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent?.indexOf(text) ?? -1;
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        const rect = range.getBoundingClientRect();
        return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
      }
      return null;
    }, SELECTED);
    expect(line).not.toBeNull();
    const release = { x: line!.right - 2, y: line!.y };

    await browser.mouse.move(line!.left + 2, line!.y);
    await browser.mouse.down();
    await browser.mouse.move((line!.left + line!.right) / 2, line!.y);
    await browser.mouse.move(release.x, release.y);
    await browser.mouse.up();
    await expect(screen.getByRole("button", "Cite selection in composer")).toBeVisible();
    await app.screenshot("cite-open");

    // A click meant to clear the selection, 5px right of and below where the drag ended.
    await browser.mouse.move(release.x + 5, release.y + 5);
    await browser.mouse.down();
    await browser.mouse.up();
    await app.screenshot("after-nearby-click");

    const citations = await browser.evaluate(
      () => document.querySelectorAll("[data-composer-citation-chip]").length,
    );
    expect(citations).toBe(0);
  },
);
