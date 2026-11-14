/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const FILE = "reports/100% #1? draft.md";

test(
  "A relative Codex citation whose name has % # ? opens its file",
  WEB,
  async ({ t3, app, browser, screen }) => {
    // The editor renders in a shadow root that locators do not reach.
    const editorText = () =>
      browser.evaluate(() => {
        for (const host of document.querySelectorAll("*")) {
          const content = host.shadowRoot?.querySelector("[data-content]");
          if (content) return content.textContent ?? "";
        }
        return null;
      });

    const project = await t3.project("demo", { [FILE]: "Title\nQuarterly draft body\n" });
    // User messages render Codex directives through the same Markdown pipeline as replies.
    const thread = await t3.thread({
      project,
      title: "Citation",
      messages: [`See :codex-file-citation{path="${FILE}" line_range_start="2"}`],
    });
    await t3.open(thread);
    // A message sent through the CLI shows collapsed under its sender.
    await screen.getByRole("button", /^Agent See/).tap();

    const citation = screen.getByRole("link", /^100% #1\? draft\.md/);
    await expect(citation).toBeVisible();
    await citation.tap();
    await expect.poll(editorText).toContain("Quarterly draft body");
    // The file opens at its workspace path, so the tree selects it and no `.` crumb appears.
    await expect
      .poll(() =>
        browser.evaluate((path) => {
          for (const host of document.querySelectorAll("*")) {
            const row = host.shadowRoot?.querySelector(`[data-item-path="${path}"]`);
            if (row) return row.getAttribute("aria-selected");
          }
          return null;
        }, FILE),
      )
      .toBe("true");
    const crumbs = await browser.evaluate(() =>
      [...document.querySelectorAll("[data-file-crumb]")].map((crumb) => crumb.textContent?.trim()),
    );
    expect(crumbs).not.toContain(".");
    await app.screenshot("citation-opened");
  },
);
