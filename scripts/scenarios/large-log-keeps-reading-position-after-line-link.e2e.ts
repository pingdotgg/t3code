/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

// Logs above 64 MiB use the streamed preview. Keep the lines under review near the front.
const log =
  Array.from({ length: 6000 }, (_, line) => `Entry ${line + 1}: Log message\n`).join("") +
  `${"Additional diagnostic context ".repeat(40)}\n`.repeat(60_000);

test(
  "A large log opened at a cited line keeps its reading position when switching file tabs",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", { "app.log": log, "notes.txt": "Review notes" });
    const thread = await t3.thread({
      project,
      title: "Review the log",
      messages: ['See :codex-file-citation{path="app.log" line_range_start="1000"}'],
    });
    await t3.open(thread);
    await browser.locator("button").filter({ hasText: "See :codex-file-citation" }).tap();
    await screen.getByRole("link", /^app\.log/).tap();
    const row = (index: number, text: string) =>
      browser.locator(`[data-preview-row="${index}"]`).filter({ hasText: text });
    await row(999, "Entry 1000:").waitFor({ timeout: 120_000 });

    await browser.evaluate(() => {
      const scroller = document
        .querySelector('[data-preview-row="999"]')!
        .closest<HTMLElement>(".overflow-auto")!;
      scroller.scrollTop += 500 * 29;
      return null;
    });
    await row(1499, "Entry 1500:").waitFor();
    const firstVisibleLine = () =>
      browser.evaluate(() => {
        const scroller = document
          .querySelector("[data-preview-row]")
          ?.closest<HTMLElement>(".overflow-auto");
        if (!scroller) return null;
        const bounds = scroller.getBoundingClientRect();
        const first = Array.from(scroller.querySelectorAll<HTMLElement>("[data-preview-row]")).find(
          (row) => row.getBoundingClientRect().bottom > bounds.top + 1,
        );
        return first ? Number(first.dataset.previewRow) + 1 : null;
      });
    const readingLine = await firstVisibleLine();

    await browser.keyboard.press("Control+p");
    await screen.getByPlaceholder("Search files…").fill("notes.txt");
    await screen.getByRole("option", "notes.txt", { exact: false }).tap();
    await screen.getByRole("button", "app.log", { exact: true }).tap();
    await screen.getByText(/66,000 lines ·/).waitFor({ timeout: 120_000 });
    try {
      await expect.poll(firstVisibleLine).toBe(readingLine);
    } finally {
      await app.screenshot("log-position-after-switching-back");
    }
  },
);
