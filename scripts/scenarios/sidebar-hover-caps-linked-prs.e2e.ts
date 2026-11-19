import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const LINKED = 20;

test(
  "The sidebar hover of a thread with 20 linked PRs lists five and counts the rest",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Many linked PRs", messages: ["first"] });
    await t3.open(thread);
    await screen.getByText("first fixture turn complete", { exact: false }).waitFor();

    // The app's own Link pull request dialog; linking records the PR without asking GitHub.
    for (let number = 101; number < 101 + LINKED; number++) {
      await browser.keyboard.press("ControlOrMeta+k");
      await screen
        .getByPlaceholder("Search commands, projects, and threads...")
        .fill("Link pull request");
      await screen.getByRole("option", "Link pull request to thread", { exact: false }).tap();
      const field = screen.getByPlaceholder("Pull request URL or #42");
      await field.fill(`https://github.com/scenario/demo/pull/${number}`);
      await field.press("Enter");
      await field.waitFor({ state: "hidden" });
    }

    await screen.getByTestId("sidebar-row-card").first().hover();
    const hover = browser
      .locator('[data-slot="tooltip-popup"]')
      .filter({ hasText: "Many linked PRs" });
    await hover.getByRole("listitem").first().waitFor();
    await app.screenshot("hover");
    await expect(hover.getByRole("listitem")).toHaveCount(5);
    await expect(hover.getByText(`+${LINKED - 5} more linked PRs`)).toBeVisible();
  },
);
