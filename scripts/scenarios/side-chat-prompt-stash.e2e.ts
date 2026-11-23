import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "The stash shortcut saves and restores the focused side chat draft",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("demo");
    await t3.open();

    const newThread = screen.getByTestId("composer-editor");
    await newThread.waitFor({ timeout: 120_000 });
    await newThread.fill("Review the changes");
    await newThread.press("Enter");

    const main = screen.getByRole("textbox", "Message Review the changes");
    await main.fill("/side ");
    await main.press("Enter");
    const side = screen.getByRole("textbox", "Message Side chat");
    await side.waitFor();
    await main.fill("Keep this main draft");
    await side.fill("Save this side draft");

    await side.press("ControlOrMeta+s");
    await app.screenshot("after-stash-shortcut");
    await expect(side).toHaveText("");
    await expect(main).toHaveText("Keep this main draft");

    await side.press("ControlOrMeta+s");
    await expect(side).toHaveText("Save this side draft");
    await expect(main).toHaveText("Keep this main draft");
  },
);
