/// <reference lib="dom" />
// The DOM lib types the functions this scenario runs in the page.
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const HEADER = Array.from({ length: 13 }, (_, index) => `C${index}`);
const ROW = [...HEADER.slice(0, 12).map(() => "x"), "folder/".repeat(40)];
const CSV = [HEADER, ROW, ROW, ROW].map((row) => row.join(",")).join("\n") + "\n";

test(
  "A CSV row keeps its height while the table scrolls sideways",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", { "paths.csv": CSV });
    const thread = await t3.thread({ project, title: "Paths", messages: ["Start"] });
    const rowHeight = () =>
      browser.evaluate(
        () =>
          document.querySelector<HTMLElement>(
            '[role="table"][aria-label="paths.csv"] [data-preview-row="1"]',
          )?.offsetHeight ?? 0,
      );

    await t3.open(thread);
    await screen.getByRole("button", "Toggle right panel").tap();
    await screen.getByRole("button", "Files F").tap();
    await screen.getByRole("treeitem", "paths.csv").tap();
    await expect(screen.getByRole("columnheader", "C0")).toBeVisible({ timeout: 60_000 });
    await expect.poll(rowHeight).toBeGreaterThan(0);
    const before = await rowHeight();
    await app.screenshot("left");

    await browser.evaluate(() => {
      const scroller = document.querySelector(
        '[role="table"][aria-label="paths.csv"]',
      )!.parentElement!;
      scroller.scrollLeft = scroller.scrollWidth;
      scroller.dispatchEvent(new Event("scroll"));
      return scroller.scrollLeft;
    });
    await expect(screen.getByRole("columnheader", "C12")).toBeVisible();
    await app.screenshot("right");
    await expect.poll(rowHeight).toBe(before);
  },
);
