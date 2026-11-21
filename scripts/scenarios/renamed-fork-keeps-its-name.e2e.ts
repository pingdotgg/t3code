import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A fork renamed before its first message keeps that name",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Earlier work", messages: ["first"] });
    await t3.open(thread);

    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();
    await screen.getByRole("button", "Fork from this response").first().tap();
    const forkActions = screen.getByRole("button", "Thread actions for Earlier work fork");
    await expect(forkActions).toBeVisible();

    await forkActions.tap();
    await screen.getByRole("menuitem", "Rename thread").tap();
    const title = screen.getByRole("textbox", "Thread title");
    await title.fill("Storage notes");
    await title.press("Enter");
    const renamedActions = screen.getByRole("button", "Thread actions for Storage notes");
    await expect(renamedActions).toBeVisible();

    const composer = screen.getByRole("textbox");
    await composer.pressSequentially("Try SQLite instead");
    await composer.press("Enter");
    // The fork shows its source's reply too, so the second one is the fork's own.
    await expect(
      screen.getByText("first fixture turn complete", { exact: false }).nth(1),
    ).toBeVisible();
    await app.screenshot("after-first-message");
    await expect(renamedActions).toBeVisible();
  },
);
