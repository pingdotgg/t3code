import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test("Find in thread matches İstanbul with istanbul", WEB, async ({ t3, app, screen, browser }) => {
  const project = await t3.project("demo");
  const thread = await t3.thread({
    project,
    title: "Travel notes",
    messages: ["Travel notes for İstanbul"],
  });
  await t3.open(thread);
  await screen.getByRole("button", /^Agent Travel notes for İstanbul/).tap();
  await browser
    .locator("[data-user-message-body]")
    .getByText("Travel notes for İstanbul", { exact: true })
    .waitFor();

  await browser.keyboard.press("Control+f");
  await screen.getByRole("searchbox", "Find in thread").fill("istanbul");
  try {
    await expect
      .poll(
        () =>
          browser.evaluate<string>(
            'document.querySelector("[data-thread-find-bar] span[aria-hidden]")?.textContent ?? ""',
          ),
        { message: "Find in thread counts İstanbul as a match for istanbul" },
      )
      .toBe("1/1");
  } finally {
    await app.screenshot("istanbul-find-result");
  }
});
