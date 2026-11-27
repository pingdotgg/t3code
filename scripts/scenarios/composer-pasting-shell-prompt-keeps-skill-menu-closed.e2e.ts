/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const OUTPUT = "NAME READY\nfoo 2/2\nuser@host ~ $";

test(
  "Pasting a shell prompt does not open the skill menu",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Shell output", messages: ["first"] });
    await t3.open(thread);
    await screen.getByRole("textbox").tap();

    const menu = () =>
      browser.evaluate(() => Boolean(document.querySelector("[data-composer-command-drawer]")));
    await browser.keyboard.type("$");
    await expect.poll(menu).toBe(true);
    await browser.keyboard.press("Backspace");
    await expect.poll(menu).toBe(false);

    await browser.evaluate((text) => {
      const editor = document.activeElement;
      if (!(editor instanceof HTMLElement) || !editor.isContentEditable) {
        throw new Error("The composer is not focused");
      }
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      editor.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      return null;
    }, OUTPUT);
    await expect
      .poll(() => browser.evaluate(() => document.activeElement?.textContent ?? ""))
      .toContain("user@host ~ $");
    try {
      expect(await menu()).toBe(false);
    } finally {
      await app.screenshot("pasted-shell-prompt");
    }

    await browser.keyboard.press("Enter");
    await screen.getByText("second fixture turn complete").waitFor();
    await screen.getByText("user@host ~ $", { exact: false }).waitFor();
  },
);
