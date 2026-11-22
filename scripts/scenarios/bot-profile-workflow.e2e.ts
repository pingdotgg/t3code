import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test("A bot continues its thread when a workflow runs", WEB, async ({ t3, screen, app }) => {
  await t3.project("Bot project");
  await t3.open();

  await screen.getByRole("button", "New bot", { exact: true }).tap();
  const editor = screen.getByRole("dialog", "New bot");
  await editor.getByRole("textbox", "Name", { exact: true }).fill("Project bot");
  await editor.getByRole("combobox", "Model").selectOption({ label: "Replay (dev) · Multi turn" });
  await editor.getByRole("textbox", "Standing instructions").fill("Summarize recent changes.");
  await editor.getByRole("button", "Save", { exact: true }).tap();
  await expect(editor).toBeHidden();

  const composer = screen.getByRole("textbox");
  await composer.fill("Start the briefing.");
  await composer.press("Enter");
  await screen.getByText("first fixture turn complete", { exact: true }).waitFor();

  await screen.getByRole("button", "Workflows", { exact: true }).tap();
  const workflows = screen.getByRole("dialog", "Bot workflows");
  await workflows.getByRole("button", "New workflow").tap();
  await workflows.getByRole("textbox", "Name", { exact: true }).fill("Morning workflow");
  await workflows.getByRole("button", "Add step").tap();
  await workflows.getByRole("textbox", "Instructions").fill("Write the daily briefing.");
  await workflows.getByRole("button", "Save", { exact: true }).tap();
  await workflows.getByRole("textbox", "Workflow input").fill("Today");
  await workflows.getByRole("button", "Run workflow").tap();
  await workflows.getByText("second fixture turn complete", { exact: true }).waitFor();
  await app.screenshot("bot-workflow-result");
  await workflows.getByRole("button", "Close", { exact: true }).tap();

  await screen.getByRole("button", "Channels", { exact: true }).tap();
  const channels = screen.getByRole("dialog", "Bot channels");
  await channels.getByRole("button", "New channel").tap();
  await channels.getByRole("textbox", "Name", { exact: true }).fill("Project coordination");
  await channels.getByRole("checkbox", "Project bot").check();
  await channels.getByRole("button", "Save", { exact: true }).tap();
  await channels
    .getByRole("textbox", "Message", { exact: true })
    .fill("Report back in this channel.");
  await channels.getByRole("button", "Send", { exact: true }).tap();
  await channels.getByText("Waiting", { exact: true }).waitFor();

  await channels.getByRole("button", "Edit", { exact: true }).tap();
  await channels
    .getByRole("combobox", "Leader", { exact: true })
    .selectOption({ label: "Project bot" });
  await channels.getByRole("button", "Save", { exact: true }).tap();
  await channels.getByText("Completed", { exact: true }).waitFor();
  await expect(channels.getByText("Report back in this channel.", { exact: true })).toBeVisible();
});
