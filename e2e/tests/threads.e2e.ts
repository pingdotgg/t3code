import { expect } from "e2e";

import { describe, test } from "../support/test.ts";

describe("thread lifecycle", { tags: ["threads"] }, () => {
  test("settling a thread can be undone with Un-settle", async ({ t3, screen }) => {
    await t3.startThread("Settle me");

    await t3.threadAction("Settle me", "Settle thread");
    const settled = screen.getByRole("alert").filter({ hasText: "This thread is settled" });
    await expect(settled).toBeVisible();

    await settled.getByRole("button", "Un-settle").tap();
    await expect(settled).not.toBeVisible();
  });

  test("an archived thread comes back with Unarchive", async ({ app, t3, screen }) => {
    await t3.startThread("Archive me");
    const row = t3.sidebarRow("Archive me");

    await t3.threadAction("Archive me", "Archive thread");
    await expect(row).not.toBeVisible();

    await app.open("/settings/archived");
    const archived = screen.getByRole("heading", "Archive me");
    await expect(archived).toBeVisible();
    await screen.getByRole("button", "Unarchive").tap();
    await expect(archived).not.toBeVisible();

    await t3.open();
    await expect(row).toBeVisible();
  });

  test("a pinned thread can be unpinned", async ({ t3, screen }) => {
    await t3.startThread("Pin me");

    await t3.threadAction("Pin me", "Pin thread");
    await expect(screen.getByRole("button", "Unpin thread")).toBeVisible();

    await t3.threadAction("Pin me", "Unpin thread");
    await expect(screen.getByRole("button", "Unpin thread")).not.toBeVisible();
  });

  test("a renamed thread keeps its title after a reload", async ({ t3, browser, screen }) => {
    await t3.startThread("Rename me");

    await t3.threadAction("Rename me", "Rename thread");
    const title = screen.getByLabel("Thread title");
    await title.fill("Release notes");
    await title.press("Enter");
    await expect(screen.getByRole("heading", "Release notes")).toBeVisible();

    await browser.reload();
    await expect(t3.sidebarRow("Release notes")).toBeVisible();
  });
});
