import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test("Oversized Markdown does not offer a rendered preview", WEB, async ({ t3, app, screen }) => {
  const project = await t3.project("docs", {
    "large.md": "# Large project notes\n\n" + "A line of project notes.\n".repeat(2_800_000),
  });
  const thread = await t3.thread({ project, title: "Read large notes", messages: ["Start"] });
  await t3.open(thread);

  await screen.getByRole("button", "Toggle right panel").tap();
  await screen.getByRole("button", "Files F").tap();
  await screen.getByRole("treeitem", "large.md").secondaryTap();
  await screen.getByRole("menuitem", "Copy path", { exact: true }).waitFor();

  await app.screenshot("oversized-markdown-file-menu");
  await expect(screen.getByRole("menuitem", "Open preview", { exact: true })).toHaveCount(0);
});
