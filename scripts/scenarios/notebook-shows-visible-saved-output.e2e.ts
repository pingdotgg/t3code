/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const notebook = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { language_info: { name: "python" } },
  cells: [
    {
      id: "results",
      cell_type: "code",
      source: [],
      metadata: {},
      execution_count: 1,
      outputs: Array.from({ length: 17 }, (_, index) => ({
        output_type: "display_data",
        metadata: {},
        data: { "text/html": `<span>Saved result ${index + 1}</span>` },
      })),
    },
  ],
};
const fifteenthOutputFrame = '[data-notebook-output="0-14"] iframe';
const lastOutput = '[data-notebook-output="0-16"]';

test(
  "A visible saved notebook output renders when earlier outputs have scrolled above it",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo", { "results.ipynb": JSON.stringify(notebook) });
    const thread = await t3.thread({ project, title: "Review results", messages: ["Start"] });
    await browser.setViewport({ width: 1440, height: 1080 });
    await t3.open(thread);
    await screen.getByText("fixture turn complete", { exact: false }).waitFor();

    await browser.keyboard.press("Control+p");
    await screen.getByPlaceholder("Search files…").fill("results.ipynb");
    await screen.getByRole("option", "results.ipynb", { exact: false }).tap();
    await browser.locator(lastOutput).waitFor({ state: "attached", timeout: 120_000 });

    // Leave room for the final output and fewer than sixteen preceding outputs.
    const height = await browser.evaluate((selector) => {
      const viewport = document.querySelector(selector)!.closest(".scrollbar-gutter-both")!;
      return window.innerHeight - viewport.clientHeight + 940;
    }, lastOutput);
    await browser.setViewport({ width: 1440, height });
    await browser.locator(fifteenthOutputFrame).waitFor({ timeout: 30_000 });
    await browser.evaluate((selector) => {
      const viewport = document.querySelector(selector)!.closest(".scrollbar-gutter-both")!;
      viewport.scrollTop = 170;
      return null;
    }, lastOutput);

    try {
      await expect
        .poll(() =>
          browser.evaluate((selector) => {
            const output = document.querySelector(selector);
            const viewport = output?.closest(".scrollbar-gutter-both");
            if (!output || !viewport) return null;
            const bounds = viewport.getBoundingClientRect();
            const row = output.getBoundingClientRect();
            if (row.top < bounds.top || row.bottom > bounds.bottom) return null;
            return (
              output.querySelector("iframe")?.contentDocument?.body?.textContent?.trim() ||
              "Output is in view but blank"
            );
          }, lastOutput),
        )
        .toBe("Saved result 17");
    } finally {
      await app.screenshot("last-saved-output");
    }
  },
);
