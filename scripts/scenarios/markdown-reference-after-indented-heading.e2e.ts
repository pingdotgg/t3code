import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A long Markdown preview resolves a reference defined after an indented heading",
  WEB,
  async ({ t3, app, screen }) => {
    const markdown =
      "[Release notes][release]\n\n" +
      "Background for this release. ".repeat(180) +
      "\n\n## Appendix\n\n  ### References\n[release]: https://example.com/releases\n";
    const project = await t3.project("documentation", { "release.md": markdown });
    const thread = await t3.thread({
      project,
      title: "Release",
      messages: ['See :codex-file-citation{path="release.md"}'],
    });
    await t3.open(thread);

    await screen.getByRole("button", /^Agent See/).tap();
    await screen.getByRole("link", /^release\.md/).tap();
    await screen.getByRole("button", "Show rendered markdown").tap();
    await screen.getByText("Background for this release.", { exact: false }).waitFor();
    await app.screenshot("release-reference");
    await expect(screen.getByRole("link", "Release notes")).toBeVisible();
  },
);
