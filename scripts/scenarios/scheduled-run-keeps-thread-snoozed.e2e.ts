import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A scheduled task's run in a snoozed thread keeps the thread snoozed",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Snoozed work", messages: ["first"] });
    await t3.open(thread);

    await screen.getByRole("button", "Snoozed work", { exact: false }).first().hover();
    await screen.getByRole("button", "Snooze thread").tap();
    await screen.getByRole("menuitem", "In 3 hours", { exact: false }).tap();
    await expect(screen.getByRole("button", "Snoozed 1")).toBeVisible();

    await app.open("/settings/scheduled-tasks");
    await screen.getByRole("button", "New task").tap();
    await screen.getByRole("textbox", "Name").fill("Automatic check");
    await screen.getByLabel("Destination").tap();
    await screen.getByRole("option", "One thread, continuing the conversation").tap();
    await screen.getByRole("combobox", "Destination thread").tap();
    await screen.getByRole("option", "Snoozed work").tap();
    await screen.getByLabel("Prompt").fill("Scheduled check-in");
    await screen.getByRole("button", "Every interval").tap();
    await screen.getByLabel("Run every").fill("1");
    await screen.getByRole("button", "Create task").tap();
    await expect(screen.getByRole("button", "Actions for Automatic check")).toBeVisible();

    await t3.open(thread);
    // The first interval run lands a minute after the task is saved, and replay finishes it.
    await expect(screen.getByRole("button", "Automation Automatic check")).toBeVisible({
      timeout: 120_000,
    });
    await expect(screen.getByText("second fixture turn complete", { exact: false })).toBeVisible({
      timeout: 60_000,
    });
    // A finished reply gets its own actions, so two mean the scheduled turn completed.
    await expect(screen.getByRole("button", "Fork from this response")).toHaveCount(2);
    await app.screenshot("after-scheduled-run");
    await expect(screen.getByRole("button", "Snoozed 1")).toBeVisible();
  },
);
