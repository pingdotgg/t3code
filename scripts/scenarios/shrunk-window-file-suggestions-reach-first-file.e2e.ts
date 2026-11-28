import { expect } from "e2e";

import {
  clickAt,
  findHittableRow,
  openFileSuggestionsUnderTallDraft,
  openThreadWithManyFiles,
  wheelSuggestions,
} from "./composer-menu.ts";
import { test, WEB } from "./t3.ts";

test(
  "After the window shrinks, file suggestions wheel up to a first suggestion the pointer can pick",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await browser.setViewport({ width: 375, height: 500 });
    await openThreadWithManyFiles(t3);
    await openFileSuggestionsUnderTallDraft(browser, screen);
    await browser.keyboard.press("Escape");
    await browser.keyboard.press("Backspace");
    await browser.keyboard.type("@");

    await browser.setViewport({ width: 375, height: 300 });
    await wheelSuggestions(browser, "up");
    await app.screenshot("scrolled-to-top");
    const first = await findHittableRow(browser, "first");
    expect(first.point).not.toBeNull();

    await clickAt(browser, first.point!);
    await expect(screen.getByRole("textbox")).toContainText(first.label!);
  },
);
