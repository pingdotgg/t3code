import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A saved scheduled task can leave its thread for one started by its next run",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("scheduled-destination");
    await t3.thread({ project, title: "Original conversation", messages: ["Start"] });
    await t3.open("/settings/scheduled-tasks");

    const mode = screen.getByRole("combobox", "Destination", { exact: true });
    const thread = screen.getByRole("combobox", "Destination thread");
    const continuing = screen.getByRole("option", "One thread, continuing the conversation");
    const actions = screen.getByRole("button", "Actions for Recurring check");
    const edit = screen.getByRole("menuitem", "Edit");

    await screen.getByRole("button", "New task").tap();
    await screen.getByRole("textbox", "Name").fill("Recurring check");
    await mode.tap();
    await continuing.tap();
    await thread.tap();
    await screen.getByRole("option", "Original conversation").tap();
    await screen.getByRole("textbox", "Prompt").fill("Check for updates");
    await screen.getByRole("button", "Create task").tap();

    await actions.tap();
    await edit.tap();
    await mode.tap();
    await screen.getByRole("option", "New thread each run").tap();
    await mode.tap();
    await continuing.tap();
    await screen.getByRole("button", "Save task").tap();
    await actions.tap();
    await edit.tap();
    await app.screenshot("saved-destination");
    await expect(thread).toContainText("Started by the first run");
  },
);
