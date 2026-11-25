/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const savedResults = Array.from({ length: 17 }, (_, index) => `Saved result ${index + 1}`);
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
      outputs: [
        { output_type: "stream", name: "stdout", text: Array(12).fill("Processing").join("\n") },
        ...savedResults.map((result) => ({
          output_type: "display_data",
          metadata: {},
          data: { "text/html": `<span>${result}</span>` },
        })),
      ],
    },
  ],
};
const lastOutput = '[data-notebook-output="0-17"]';

test(
  "All saved notebook outputs render when they fit in a tall preview",
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

    // The stream puts the final result below the fold until the user scrolls.
    const height = await browser.evaluate((selector) => {
      const viewport = document.querySelector(selector)!.closest(".scrollbar-gutter-both")!;
      return window.innerHeight - viewport.clientHeight + 1070;
    }, lastOutput);
    await browser.setViewport({ width: 1440, height });
    await browser.locator('[data-notebook-output="0-15"] iframe').waitFor({ timeout: 30_000 });
    await browser.evaluate((selector) => {
      const viewport = document.querySelector(selector)!.closest(".scrollbar-gutter-both")!;
      viewport.scrollTop = viewport.scrollHeight;
      return null;
    }, lastOutput);

    try {
      await expect
        .poll(() =>
          browser.evaluate((selector) => {
            const viewport = document.querySelector(selector)!.closest(".scrollbar-gutter-both")!;
            const bounds = viewport.getBoundingClientRect();
            return Array.from(viewport.querySelectorAll("[data-notebook-output]"), (output) => {
              const row = output.getBoundingClientRect();
              if (row.top < bounds.top || row.bottom > bounds.bottom) return "Output is offscreen";
              return (
                output.querySelector("iframe")?.contentDocument?.body?.textContent?.trim() ||
                "Output is in view but blank"
              );
            });
          }, lastOutput),
        )
        .toEqual(savedResults);
    } finally {
      await app.screenshot("last-saved-output-in-tall-preview");
    }
  },
);
