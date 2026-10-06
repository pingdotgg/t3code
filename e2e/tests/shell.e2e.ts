import { expect } from "e2e";

import { describe, test } from "../support/test.ts";

describe("app shell", { tags: ["smoke"] }, () => {
  test("opens the bootstrap thread in its project", async ({ t3, screen }) => {
    await t3.open();
    await expect(t3.sidebarRow("New thread")).toBeVisible();
    await expect(screen.getByRole("heading", "New thread")).toBeVisible();
  });

  test("enables submit once the composer has text", async ({ t3, screen }) => {
    await t3.open();
    const submit = screen.getByRole("button", "Submit message");
    await expect(submit).toBeDisabled();
    await screen.getByRole("textbox", "Message").fill("Explain src/greet.ts");
    await expect(submit).toBeEnabled();
  });

  test("opens settings from the sidebar", async ({ t3, browser, screen }) => {
    await t3.open();
    await screen.getByRole("navigation", "Threads").getByRole("button", "Settings").tap();
    await expect(browser).toHaveURL(/\/settings\//);
  });
});
