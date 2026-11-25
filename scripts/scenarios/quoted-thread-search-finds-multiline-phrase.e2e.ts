import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Opening a quoted search result finds the phrase across lines in a code block",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Weekly notes", messages: ["Start"] });
    await t3.open(thread);

    const composer = screen.getByRole("textbox", "Message Weekly notes");
    await composer.fill("```text\ncanary\n    migration\n```");
    await composer.press("Enter");
    await screen.getByText("second fixture turn complete").waitFor();

    const query = screen.getByRole("combobox", "Search threads");
    await query.fill('"canary migration"');
    await screen.getByRole("option").filter({ hasText: "canary migration" }).tap();

    const find = browser.locator('[role="search"][aria-label="Find in thread"]');
    await browser.locator('[data-thread-find-bar] [aria-busy="false"]').waitFor();
    await app.screenshot("quoted-search-in-thread");
    await expect(find).toContainText("1/1");
  },
);
