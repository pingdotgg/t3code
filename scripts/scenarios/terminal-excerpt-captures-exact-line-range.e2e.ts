/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Adding two terminal rows to chat shows their exact Japanese line range",
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
    // Read the real clipboard payload because the terminal rows are drawn on a canvas.
    await browser.evaluate(() => {
      window.addEventListener("copy", (event) => {
        document.body.dataset.terminalCopy = event.clipboardData?.getData("text/plain") ?? "";
      });
      return null;
    });
    const copySelection = async () => {
      await input.focus();
      await browser.evaluate(() => {
        delete document.body.dataset.terminalCopy;
        return null;
      });
      await browser.keyboard.press("Control+Shift+A");
      await browser.keyboard.press("Control+Shift+C");
      return browser.evaluate(() => document.body.dataset.terminalCopy?.trim() ?? "");
    };
    await expect.poll(copySelection, { timeout: 15_000 }).not.toBe("");
    // Clear the screen and scrollback, print exactly two rows, and keep the next prompt offscreen.
    await browser.keyboard.type(
      "printf '\\033[3J\\033[2J\\033[Hfirst row\\r\\nsecond row'; sleep 60",
    );
    await browser.keyboard.press("Enter");
    await expect.poll(copySelection, { timeout: 15_000 }).toBe("first row\nsecond row");
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

    const excerpt = screen.getByRole("button", /ターミナルの抜粋、ターミナル 2/);
    await expect(excerpt).toHaveText("ターミナル 2 1–2 行目");
    await app.screenshot("terminal-excerpt-two-lines");
  },
);
