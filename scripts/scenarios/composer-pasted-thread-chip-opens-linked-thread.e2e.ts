/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A thread chip pasted after a carriage-return heading boundary links to its thread",
  WEB,
  async ({ t3, browser, screen }) => {
    const project = await t3.project("demo");
    const linked = await t3.thread({
      project,
      title: "Release notes",
      messages: ["Draft the notes"],
    });
    await t3.open(linked);
    const destination = await browser.evaluate(() => window.location.pathname);
    const thread = await t3.thread({
      project,
      title: "Follow-up",
      messages: ["Start a follow-up"],
    });
    await t3.open(thread);
    const composer = screen.getByRole("textbox");
    await composer.tap();
    await browser.evaluate((threadId: string) => {
      const environmentId = decodeURIComponent(window.location.pathname.split("/")[1]!);
      const href = `t3-thread://v2/${environmentId}/${threadId}`;
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", `First paragraph \`\r# <${href}>\rSecond paragraph \``);
      const editor = document.activeElement;
      if (!editor?.matches('[contenteditable="true"]')) throw new Error("Composer is not focused");
      return editor.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }, linked.threadId);
    const chip = composer.getByRole("link", "Thread, Release notes");
    await expect(chip).toBeVisible();
    expect(decodeURIComponent((await chip.getAttribute("href")) ?? "")).toBe(
      decodeURIComponent(destination),
    );
  },
);
