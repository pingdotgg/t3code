import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A footnote only links back to references rendered in the Markdown preview",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const markdown =
      "Background. ".repeat(11_000) +
      "[^note]\n\nVisible reference[^note].\n\n[^note]: Shared explanation.\n";
    const project = await t3.project("documentation", { "release.md": markdown });
    const thread = await t3.thread({
      project,
      title: "Release notes",
      messages: ['See :codex-file-citation{path="release.md"}'],
    });
    await t3.open(thread);

    await screen.getByRole("button", /^Agent See/).tap();
    await screen.getByRole("link", /^release\.md/).tap();
    await screen.getByRole("button", "Show rendered markdown").tap();
    await screen.getByText("Shared explanation.", { exact: false }).waitFor();
    await app.screenshot("footnote-backlinks");
    await expect(browser.locator("section[data-footnotes] a[data-footnote-backref]")).toHaveCount(
      1,
    );
  },
);
