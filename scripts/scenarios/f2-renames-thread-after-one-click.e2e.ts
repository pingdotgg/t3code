import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "F2 renames a thread after one click on its sidebar row",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const open = await t3.thread({ project, title: "Release notes", messages: ["first"] });
    await t3.thread({ project, title: "Login redirect", messages: ["first"] });
    await t3.open(open);

    await screen.getByRole("button", "Login redirect", { exact: false }).tap();
    await browser.locator('[data-testid="composer-editor"]:focus').waitFor();
    await browser.keyboard.press("F2");
    await app.screenshot("after-f2");

    await expect(screen.getByRole("textbox", "Thread title")).toBeFocused();
  },
);
