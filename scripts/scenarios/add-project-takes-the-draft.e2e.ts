import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A project added from the draft's project picker takes the draft's prompt with it",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const workspace = await t3.project("demo", { "next/README.md": "" });
    await t3.open();

    const composer = screen.getByRole("textbox");
    await composer.fill("Plan the next project");
    // The draft's project picker has no accessible name of its own.
    const projectPicker = browser.locator("[data-draft-project-trigger]");
    await projectPicker.tap();
    await screen.getByRole("option", "Add project").tap();
    await screen.getByText("Local folder").tap();
    await screen.getByRole("combobox").fill(`${workspace}/next`);
    await browser.keyboard.press("Enter");

    await expect(projectPicker).toHaveText("next");
    await app.screenshot("after-add");
    await expect(composer).toContainText("Plan the next project");
    await expect(
      screen.getByRole("button", "Plan the next project, Unsent draft", { exact: false }),
    ).toBeHidden();
  },
);
