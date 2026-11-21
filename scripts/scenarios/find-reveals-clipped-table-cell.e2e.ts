/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const MATCH = "quartzneedle";
const columns = Array.from({ length: 16 }, (_, index) => `DiagnosticsColumn${index + 1}`);
const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
const TABLE = [
  row(columns),
  row(columns.map(() => "---")),
  row([...columns.slice(0, -1).map(() => "pending"), MATCH]),
].join("\n");

test(
  "Find reveals a match in the last column of a wide table",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("wide-table");
    const thread = await t3.thread({ project, title: "Diagnostics table", messages: [TABLE] });
    await t3.open(thread);
    await screen.getByText("first fixture turn complete", { exact: false }).waitFor({
      timeout: 120_000,
    });

    await browser.keyboard.press("Control+f");
    const find = screen.getByRole("searchbox", "Find in thread");
    await find.fill(MATCH);

    try {
      await expect
        .poll(
          () =>
            browser.evaluate((query) => {
              const active = CSS.highlights.get("t3-thread-find-active");
              const match =
                active &&
                [...active].find((range) => range instanceof Range && range.toString() === query);
              const viewport = match?.startContainer.parentElement?.closest(
                '.chat-markdown-table-container [data-slot="scroll-area-viewport"]',
              );
              if (!(match instanceof Range) || !viewport)
                return "Table match has no active highlight";
              const rect = match.getBoundingClientRect();
              const clip = viewport.getBoundingClientRect();
              return rect.height > 0 && rect.left >= clip.left - 1 && rect.right <= clip.right + 1
                ? "Selected table match is inside the horizontal viewport"
                : "Selected table match is clipped horizontally";
            }, MATCH),
          { timeout: 20_000 },
        )
        .toBe("Selected table match is inside the horizontal viewport");
    } finally {
      await app.screenshot("selected-table-match");
    }
  },
);
