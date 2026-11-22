import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Find in thread matches the displayed line range of a file link",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo", { "src/notes.ts": "// Notes\n".repeat(64) });
    const thread = await t3.thread({
      project,
      title: "File review",
      messages: ["See [src/notes.ts](src/notes.ts#L42-L64)"],
    });
    await t3.open(thread);
    await screen.getByRole("button", /^Agent See/).tap();
    await browser
      .locator("[data-user-message-body]")
      .getByText("notes.ts · L42–64", { exact: true })
      .waitFor();

    await browser.keyboard.press("Control+f");
    await screen.getByRole("searchbox", "Find in thread").fill("L42–64");
    try {
      await expect
        .poll(
          () =>
            browser.evaluate<string>(
              'document.querySelector("[data-thread-find-bar] span[aria-hidden]")?.textContent ?? ""',
            ),
          { message: "Find in thread counts the displayed line range as a match" },
        )
        .toBe("1/1");
    } finally {
      await app.screenshot("file-range-find-result");
    }
  },
);
