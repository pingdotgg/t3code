import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Edit from here puts a sent message back with its thread mention",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    await t3.thread({ project, title: "Release notes", messages: ["Draft the notes"] });
    const thread = await t3.thread({ project, title: "Review work", messages: ["Start"] });
    await t3.open(thread);

    const composer = screen.getByRole("textbox");
    await composer.pressSequentially("Review @Release");
    await screen.getByRole("option", "Release notes", { exact: false }).tap();
    await expect(composer).toContainText("Release notes");
    await browser.keyboard.press("Enter");

    // The seeded message came from the CLI, which the timeline attributes to an agent: only the
    // message sent here offers Edit from here.
    const editFromHere = screen.getByRole("button", "Edit from here");
    await expect(editFromHere).toHaveCount(1, { timeout: 60_000 });
    await expect(editFromHere).toBeEnabled({ timeout: 60_000 });
    await editFromHere.tap();
    await screen.getByRole("button", "Revert and keep changes").tap();

    await expect(composer).toContainText("Review");
    await app.screenshot("restored-draft");
    await expect(composer).toContainText("Release notes");
  },
);
