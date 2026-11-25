/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "The line range on a terminal excerpt follows the app language",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Terminal work", messages: ["Start"] });

    await t3.open("/settings/general");
    await screen.getByLabel("Language", { exact: true }).tap();
    await screen.getByText("日本語", { exact: true }).tap();
    await screen.getByLabel("言語", { exact: true }).waitFor();

    await t3.open(thread);
    await screen.getByRole("button", "ターミナルドロワーの切り替え").tap();
    await screen.getByRole("button", /^新しいターミナル(?: \(|$)/).tap();
    await screen.getByRole("button", "ターミナル 2", { exact: true }).waitFor();

    const inputSelector = '[aria-label="ターミナルの入力"][data-workspace-focus-default]';
    const input = browser.locator(inputSelector);
    await input.waitFor();
    await input.focus();
    await browser.keyboard.press("Control+Shift+A");
    await browser.evaluate((selector) => {
      const canvas = document.activeElement?.matches(selector)
        ? document.activeElement.parentElement?.querySelector("canvas")
        : null;
      if (!canvas) throw new Error("The focused terminal has no canvas.");
      const { x, y } = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: x + 20,
          clientY: y + 20,
        }),
      );
      return null;
    }, inputSelector);
    await screen.getByText("チャットに追加", { exact: true }).tap();

    const excerpt = screen.getByRole("button", /ターミナル 2.*(?:lines?|行)/);
    await excerpt.waitFor();
    await app.screenshot("terminal-excerpt-line-range");
    await expect(excerpt).toHaveText(/行/);
  },
);
