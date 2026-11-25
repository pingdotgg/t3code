import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "One ArrowDown after typing in the command palette selects the second result",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("fleet-api");
    await t3.project("fleet-web");
    await t3.open(await t3.thread({ project, title: "Notes", messages: ["Start"] }));
    await expect(screen.getByText("fixture turn complete", { exact: false })).toBeVisible();

    await browser.keyboard.press("ControlOrMeta+k");
    const input = screen.getByPlaceholder("Search commands, projects, and threads...");
    await expect(input).toBeFocused();
    await input.pressSequentially("fleet");
    await expect(screen.getByRole("option", "fleet-web", { exact: false }).first()).toBeVisible();

    await browser.keyboard.press("ArrowDown");
    await app.screenshot("after-one-arrow-down");
    await expect(screen.getByRole("option").nth(1)).toHaveAttribute("data-active", "true");
  },
);
