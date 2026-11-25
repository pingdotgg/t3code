import { expect } from "e2e";

import { test, WEB } from "./lathe.ts";

test(
  "Labs' Boring sidebar switches are read-only while a project is selected",
  WEB,
  async ({ lathe, app, browser, screen }) => {
    await lathe.project("demo");
    await lathe.open("/settings/labs");

    await screen.getByRole("switch", "Boring sidebar (group by project)").check();
    await expect(screen.getByRole("switch", "Two-line folder rows")).toBeVisible();

    await screen.getByRole("button", "Project scope: All projects").tap();
    await screen.getByRole("menuitemradio").filter({ hasText: "demo" }).tap();
    await expect(screen.getByRole("button", "Project scope: demo")).toBeVisible();
    await app.screenshot("project-selected");

    // A project cannot override a device preference, so neither switch may offer an edit.
    await expect(
      browser.locator('[inert] [aria-label="Boring sidebar (group by project)"]'),
    ).toBeVisible();
    await expect(browser.locator('[inert] [aria-label="Two-line folder rows"]')).toBeVisible();
  },
);
