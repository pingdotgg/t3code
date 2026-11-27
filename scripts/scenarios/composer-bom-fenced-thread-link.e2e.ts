/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A BOM-prefixed paste keeps its fenced thread link literal and chips the link after it",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const linked = await t3.thread({
      project,
      title: "Release notes",
      messages: ["Draft the notes"],
    });
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
      const link = `<t3-thread://v2/${environmentId}/${threadId}>`;
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", `\uFEFF~~~\n${link}\n~~~\n${link}`);
      const editor = document.activeElement;
      if (!editor?.matches('[contenteditable="true"]')) throw new Error("Composer is not focused");
      return editor.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }, linked.threadId);
    await composer.getByText("Plain text", { exact: true }).waitFor();
    await app.screenshot("pasted-bom-fence");
    await expect(composer.getByText(/^<t3-thread:\/\/v2\//)).toBeVisible();
    await expect(composer.getByText("Release notes", { exact: true })).toBeVisible();
  },
);
