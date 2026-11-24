import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const MESSAGE = "**已返回总部工作。**据美联社报道";
const SHOWN = "已返回总部工作。据美联社报道";

test(
  "Find in thread matches CJK bold text as the chat shows it",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "CJK find", messages: [MESSAGE] });
    await t3.open(thread);
    await screen.getByRole("button", /已返回总部工作/).tap();

    await browser.keyboard.press("Control+f");
    await screen.getByRole("searchbox", "Find in thread").fill(SHOWN);
    try {
      await expect
        .poll(
          () =>
            browser.evaluate<string>(
              'document.querySelector("[data-thread-find-bar] span[aria-hidden]")?.textContent ?? ""',
            ),
          { message: "Find in thread matches the bold text as displayed, without the asterisks" },
        )
        .toBe("1/1");
    } finally {
      await app.screenshot("cjk-bold-find-result");
    }
  },
);
