import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A bracketed text line appears once in the Markdown preview",
  WEB,
  async ({ t3, app, screen }) => {
    const line = "[Release [candidate]: https://example.com/releases";
    const project = await t3.project("documentation", {
      "release.md": `${line}\n\nPublish the notes.\n`,
    });
    const thread = await t3.thread({
      project,
      title: "Release",
      messages: ['See :codex-file-citation{path="release.md"}'],
    });
    await t3.open(thread);

    await screen.getByRole("button", /^Agent See/).tap();
    await screen.getByRole("link", /^release\.md/).tap();
    await screen.getByRole("button", "Show rendered markdown").tap();
    await screen.getByText("Publish the notes.", { exact: true }).waitFor();
    await app.screenshot("bracketed-text-line");
    await expect(screen.getByText("[Release [candidate]:", { exact: false })).toHaveCount(1);
  },
);
