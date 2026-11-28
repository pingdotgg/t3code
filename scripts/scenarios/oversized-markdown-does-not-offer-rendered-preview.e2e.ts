import { expect } from "e2e";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The scenario edits a local fixture outside the app.
import * as NodeFSP from "node:fs/promises";

import { test, WEB } from "./t3.ts";

test("Markdown preview respects file size", WEB, async ({ t3, app, screen, browser }) => {
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
  const file = `${project}/large.md`;
  const row = screen.getByRole("treeitem", "large.md");
  const preview = screen.getByRole("menuitem", "Open preview", { exact: true });
  await browser.keyboard.press("Escape");
  await NodeFSP.writeFile(file, "# Short notes\n");
  await row.secondaryTap();
  await expect(preview).toBeVisible();
  await browser.keyboard.press("Escape");
  await NodeFSP.truncate(file, 64 * 1024 * 1024 + 1);
  await row.secondaryTap();
  await screen.getByRole("menuitem", "Copy path", { exact: true }).waitFor();
  await expect(preview).toHaveCount(0);
});
