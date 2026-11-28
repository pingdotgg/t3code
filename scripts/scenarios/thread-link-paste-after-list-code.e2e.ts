/// <reference lib="dom" />
import { expect } from "e2e";

import { environmentId, runPromise, test, WEB } from "./t3.ts";

test(
  "A thread link pasted after a list code example becomes a chip",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const source = await t3.thread({
      project,
      title: "Release checklist",
      messages: ["Checklist"],
    });
    const target = await t3.thread({ project, title: "Release notes", messages: ["Notes"] });
    const environment = await runPromise(environmentId(app.baseUrl ?? ""));
    const href = `https://app.t3.codes/threads/${environment}/${encodeURIComponent(source.threadId)}`;
    await t3.open(target);
    await screen.getByRole("textbox").tap();

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
    }, `- \`\`\`text\n  example\n\nSee [Release checklist](${href})`);

    await app.screenshot("pasted-thread-link");
    await expect(browser.locator('[role="textbox"] [data-slot="context-chip-label"]')).toHaveText(
      "Release checklist",
    );
  },
);
