import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

// Scenarios title with a Codex command that always fails, so reaching it is the fixed behavior;
// the bug refused first with "This thread has no messages to title yet."
test(
  "Regenerate title on a fresh fork reaches the title model with the inherited history",
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
    await screen.getByRole("menuitem", "Regenerate title").tap();
    await expect(screen.getByText("Failed to regenerate thread title")).toBeVisible();
    await app.screenshot("regenerate-result");
    await expect(screen.getByText("Codex CLI command", { exact: false })).toBeVisible();
  },
);
