import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test("Preview keeps the Markdown default", WEB, async ({ t3, app, screen }) => {
  const project = await t3.project("docs", {
    "README.md": "# Project overview",
    "notes.md": "# Release notes",
  });
  const thread = await t3.thread({ project, title: "Read docs", messages: ["Start"] });
  await t3.open(thread);

  await screen.getByRole("button", "Toggle right panel").tap();
  await screen.getByRole("button", "Files F").tap();
  await screen.getByRole("treeitem", "README.md").secondaryTap();
  await screen.getByRole("menuitem", "Open preview", { exact: true }).tap();
  await screen.getByRole("heading", "Project overview", { exact: true }).waitFor();

  await screen.getByRole("treeitem", "notes.md").tap();
  await screen.getByRole("button", /Show (rendered markdown|markdown source)/).waitFor();
  await app.screenshot("normally-opened-notes");
  await expect(screen.getByRole("button", "Show rendered markdown", { exact: true })).toBeVisible();

  await screen.getByRole("treeitem", "README.md").secondaryTap();
  await screen.getByRole("menuitem", "Open preview", { exact: true }).tap();
  await screen.getByRole("heading", "Project overview", { exact: true }).waitFor();
  await screen.getByRole("treeitem", "README.md").tap();
  await expect(screen.getByRole("button", "Show rendered markdown", { exact: true })).toBeVisible();

  await screen.getByRole("button", "Show rendered markdown", { exact: true }).tap();
  await screen.getByRole("treeitem", "README.md").secondaryTap();
  await screen.getByRole("menuitem", "Open preview", { exact: true }).tap();
  await screen.getByRole("button", "Show markdown source", { exact: true }).tap();
  await expect(screen.getByRole("button", "Show rendered markdown", { exact: true })).toBeVisible();
  await screen.getByRole("treeitem", "notes.md").tap();
  await expect(screen.getByRole("heading", "Release notes", { exact: true })).toBeVisible();
});
