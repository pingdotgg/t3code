import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "An active mention search accepts a filename containing spaces",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("mention-search", {
      "Foreign Subsidiaries/Script Notes.md": "Fixture notes\n",
      "Foreign Unrelated.md": "Other fixture\n",
    });
    await t3.open();
    const composer = screen.getByRole("textbox");
    await composer.fill("Inspect @Foreign");
    await expect(screen.getByRole("option").first()).toBeVisible();
    await expect(screen.getByText("Foreign Unrelated.md", { exact: true })).toBeVisible();
    await composer.press("End");
    await composer.press("Space");
    await app.screenshot("multiword-search");
    await expect(screen.getByRole("option").first()).toBeVisible();
    for (const character of "Subsidiaries") await composer.press(character);
    await expect(screen.getByText("Foreign Unrelated.md", { exact: true })).toBeHidden();
    await expect(screen.getByRole("option", "Foreign Subsidiaries", { exact: true })).toBeVisible();
    await composer.press("Enter");
    await expect(
      screen.getByRole("button", "Preview Foreign Subsidiaries", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByRole("listbox", "Files and folders")).toBeHidden();
    await app.screenshot("accepted-mention");
  },
);
