/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A prompt stashed in another tab appears in the open stash menu",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const reader = await t3.thread({ project, title: "Reading", messages: ["first"] });
    const writer = await t3.thread({ project, title: "Writing", messages: ["second"] });
    await t3.open(reader);

    await screen.getByTestId("composer-editor").tap();
    await browser.keyboard.press("Control+s");
    await screen.getByRole("list", "Stashed prompts").waitFor();

    // A second signed-in document shares storage while keeping its own app state.
    await browser.evaluate((threadId) => {
      const frame = document.createElement("iframe");
      frame.id = "second-client";
      frame.src = location.pathname.replace(/[^/]+$/, threadId);
      frame.style.cssText =
        "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647";
      document.body.append(frame);
      return null;
    }, writer.threadId);

    const other = browser.frameLocator("#second-client");
    const editor = other.getByTestId("composer-editor");
    const prompt = "Draft from the other tab";
    await editor.fill(prompt);
    await browser.keyboard.press("Control+s");
    await other.getByRole("button", "Stashed prompts: 1. Open stash.").waitFor();
    await browser.evaluate(() => {
      document.querySelector("#second-client")?.remove();
      return null;
    });

    await app.screenshot("stash-after-other-tab-saves");
    await expect(screen.getByRole("button", `Restore stashed prompt: ${prompt}`)).toBeVisible();
  },
);
