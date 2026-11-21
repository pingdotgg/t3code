import { expect } from "e2e";

import {
  clickAt,
  findHittableRow,
  openFileSuggestionsUnderTallDraft,
  openThreadWithManyFiles,
  wheelSuggestions,
} from "./composer-menu.ts";
import { test, WEB } from "./lathe.ts";

test(
  "In a short window, file suggestions wheel down to a last file the pointer can pick",
  WEB,
  async ({ lathe, app, browser, screen }) => {
    await browser.setViewport({ width: 375, height: 500 });
    await openThreadWithManyFiles(lathe);
    await openFileSuggestionsUnderTallDraft(browser, screen);

    await wheelSuggestions(browser, "down");
    await app.screenshot("scrolled-to-bottom");
    const last = await findHittableRow(browser, "last-file");
    expect(last.label).toBe("README.md");
    expect(last.point).not.toBeNull();

    await clickAt(browser, last.point!);
    await expect(screen.getByRole("textbox")).toContainText("README.md");
  },
);
