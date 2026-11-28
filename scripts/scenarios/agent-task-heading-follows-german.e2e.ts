import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "The task list heading follows the German app language",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({
      project,
      title: "Plan the work",
      model: "todo-list",
      messages: ["Make a task list for this work"],
    });

    await t3.open("/settings/appearance");
    await screen.getByRole("button", /^Thread details: \d+ of \d+ on$/).tap();
    await screen.getByRole("menuitemcheckbox", "Agent tasks").tap();

    await t3.open("/settings/general");
    await screen.getByLabel("Language", { exact: true }).tap();
    await screen.getByText("Deutsch", { exact: true }).tap();
    await screen.getByLabel("Sprache", { exact: true }).waitFor();

    await t3.open(thread);
    const toggle = screen.getByRole("button", "Thread-Detailpanel umschalten");
    await toggle.waitFor();
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.tap();
    const heading = browser.locator(
      '[data-thread-details-panel] h3[id="thread-details-tasks-heading"]:visible',
    );
    await heading.waitFor();

    await app.screenshot("agent-task-heading-in-german");
    await expect(heading).toHaveText("Aufgaben");

    const expand = screen.getByRole("button", "Aufgaben ausklappen, 3 von 3 erledigt", {
      exact: true,
    });
    await expect(expand).toBeVisible();
    await expect(screen.getByText("Alles erledigt", { exact: true })).toBeVisible();
    await expand.tap();
    await expect(
      screen.getByRole("button", "Aufgaben einklappen, 3 von 3 erledigt", { exact: true }),
    ).toBeVisible();

    await t3.open("/settings/appearance");
    await screen.getByRole("button", /^Thread-Details: \d+ von \d+ an$/).tap();
    await expect(
      screen.getByRole("menuitemcheckbox", "Agentenaufgaben", { exact: true }),
    ).toHaveAttribute("aria-checked", "true");
  },
);
