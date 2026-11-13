import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Enter sends prose after a mention prefix even before search settles",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("mention-prose", { "README.md": "Fixture readme\n" });
    await t3.open();
    const composer = screen.getByRole("textbox");
    await composer.fill("Check @READ");
    await expect(screen.getByRole("option", "README.md", { exact: true })).toBeVisible();
    for (const character of "ME and fix it")
      await composer.press(character === " " ? "Space" : character);
    await app.screenshot("prose-before-enter");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect(screen.getByText("This turn is a replay.", { exact: false })).toBeVisible();
    await app.screenshot("prose-sent");
  },
);
