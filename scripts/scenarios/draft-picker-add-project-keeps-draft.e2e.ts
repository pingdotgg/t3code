import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Adding a project from the draft's project picker moves the typed draft to it",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const workspace = await t3.project("alpha", { "next/README.md": "" });
    await t3.open();

    const composer = screen.getByRole("textbox");
    await composer.fill("Plan the next project");
    const projectPicker = browser.locator("[data-draft-project-trigger]");
    await expect(projectPicker).toHaveText("alpha");
    await app.screenshot("draft-in-alpha");
    await projectPicker.tap();
    await screen.getByRole("option", "Add project").tap();
    await screen.getByText("Local folder").tap();
    await screen.getByRole("combobox").fill(`${workspace}/next`);
    await browser.keyboard.press("Enter");

    await expect(projectPicker).toHaveText("next");
    await app.screenshot("after-add");
    await expect(composer).toContainText("Plan the next project");
  },
);
