import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const MESSAGE = "**已返回总部工作。**据美联社报道";

test(
  "Bold text ending in Chinese punctuation closes before Chinese text that follows it",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "CJK bold", messages: [MESSAGE] });
    await t3.open(thread);
    await screen.getByRole("button", /已返回总部工作/).tap();
    try {
      await expect(browser.locator("strong").filter({ hasText: "已返回总部工作。" })).toBeVisible();
    } finally {
      await app.screenshot("cjk-bold-closes");
    }
  },
);
