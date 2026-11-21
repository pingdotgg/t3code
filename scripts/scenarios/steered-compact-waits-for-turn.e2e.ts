import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test("/compact sent while the agent works waits for the turn", WEB, async ({ t3, app, screen }) => {
  const project = await t3.project("demo");
  // The showcase recording streams for several seconds, long enough to send into its turn.
  const thread = await t3.thread({
    project,
    title: "Long work",
    messages: ["Show me around"],
    model: "showcase",
  });
  await t3.open(thread);

  const composer = screen.getByRole("textbox");
  await composer.tap();
  await composer.pressSequentially("Show me again");
  await composer.press("Enter");
  await expect(screen.getByRole("button", "Stop generation")).toBeVisible();

  // The trailing space closes the slash menu so Enter sends instead of picking a command.
  await composer.pressSequentially("/compact ");
  await composer.press("Enter");
  await app.screenshot("compact-sent");

  await expect(screen.getByRole("button", "Edit queued message")).toBeVisible();
});
