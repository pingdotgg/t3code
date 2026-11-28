/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const csv = [
  "Event,Details",
  ...Array.from({ length: 6500 }, (_, index) =>
    index < 6470
      ? `Event ${index + 1},${"completed ".repeat(16)}`
      : `Event ${index + 1},${"long entry wraps in the preview ".repeat(35)}`,
  ),
].join("\n");
const lastRow = '[data-preview-row="6500"]';

test(
  "A large CSV preview stays at the end of its wrapped rows when switching file tabs",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", { "events.csv": csv, "notes.txt": "Review notes" });
    const thread = await t3.thread({ project, title: "Review events", messages: ["Start"] });
    await t3.open(thread);
    await screen.getByRole("textbox", "Message Review events").waitFor();

    const openFile = async (name: string) => {
      await browser.keyboard.press("Control+p");
      await screen.getByPlaceholder("Search files…").fill(name);
      await screen.getByRole("option", name, { exact: false }).tap();
    };
    await openFile("events.csv");
    await screen.getByText(/6,500 rows · 2 columns ·/).waitFor({ timeout: 120_000 });
    await browser.locator('[data-preview-row="1"]').filter({ hasText: "Event 1" }).waitFor({
      timeout: 120_000,
    });
    await browser.evaluate(() => {
      document.querySelector("[data-preview-row]")!.closest<HTMLElement>(".overflow-auto")!.focus();
      return null;
    });
    await browser.keyboard.press("End");

    const lastRowInView = () =>
      browser.evaluate((selector) => {
        const row = document.querySelector(selector);
        if (!row?.textContent?.includes("Event 6500")) return false;
        const viewport = row.closest<HTMLElement>(".overflow-auto")!.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        return bounds.bottom <= viewport.bottom + 2 && bounds.bottom > viewport.top;
      }, lastRow);
    await expect.poll(lastRowInView).toBe(true);

    await openFile("notes.txt");
    await screen.getByRole("button", "events.csv", { exact: true }).tap();
    try {
      await expect.poll(lastRowInView).toBe(true);
    } finally {
      await app.screenshot("csv-position-after-switching-back");
    }
  },
);
