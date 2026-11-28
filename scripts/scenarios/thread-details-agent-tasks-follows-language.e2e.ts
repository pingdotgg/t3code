import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test("Agent tasks follows the German language setting", WEB, async ({ t3, app, screen }) => {
  await t3.project("demo");
  await t3.open("/settings/general");
  await screen.getByLabel("Language", { exact: true }).tap({ timeout: 120_000 });
  await screen.getByText("Deutsch", { exact: true }).tap();
  await screen.getByLabel("Sprache", { exact: true }).waitFor();

  await t3.open("/settings/appearance");
  await screen.getByRole("button", /^Thread-Details: \d+ von \d+ an$/).tap({ timeout: 120_000 });
  await screen.getByText("In Thread-Details anzeigen", { exact: true }).waitFor();

  await app.screenshot("german-thread-details-options");
  await expect(screen.getByRole("menuitemcheckbox", "Agent tasks", { exact: true })).toHaveCount(0);
  await expect(
    screen.getByRole("menuitemcheckbox", "Aufgaben des Agenten", { exact: true }),
  ).toHaveCount(1);
});
