/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A draft moved to another project uses the destination's default workspace",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("checkout-project", {
      "t3.json": JSON.stringify({ defaultThreadEnvMode: "local" }),
    });
    await t3.project("worktree-project", {
      "t3.json": JSON.stringify({ defaultThreadEnvMode: "worktree" }),
    });
    await t3.open();

    const picker = browser.locator("[data-draft-project-trigger]");
    const workspace = browser.locator('[data-composer-shortcut="composer.workspace"]');
    const pick = async (name: string) => {
      await picker.tap();
      await screen.getByRole("option", name, { exact: true }).tap();
      await picker.filter({ hasText: name }).waitFor();
    };

    // Open an empty draft in each project so both defaults are loaded.
    await picker.waitFor();
    const initialProject = await browser.evaluate(
      () => document.querySelector("[data-draft-project-trigger]")?.textContent?.trim() ?? "",
    );
    if (initialProject !== "worktree-project") {
      await pick("worktree-project");
    }
    await workspace.filter({ hasText: "New worktree" }).waitFor();
    await pick("checkout-project");
    await workspace.filter({ hasText: "Current checkout" }).waitFor();
    await screen.getByRole("textbox").fill("Plan the implementation");

    await pick("worktree-project");
    await app.screenshot("workspace-after-moving-draft");
    await expect(workspace).toContainText("New worktree");
  },
);
