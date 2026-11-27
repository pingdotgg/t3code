/// <reference lib="dom" />
import { expect } from "e2e";

import { pasteWideScreenshot } from "./image-compression-hold.ts";
import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    attachmentPaste: {
      copied: Promise<ClipboardItem>;
      downloading: Promise<void>;
      finish: () => Promise<void>;
    };
  }
}

test(
  "A pasted screenshot finishes attaching after switching away from its draft",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const source = await t3.thread({ project, title: "Screenshot work", messages: ["first"] });
    await t3.thread({ project, title: "Other work", messages: ["Other thread prompt"] });

    await browser.addInitScript(() => {
      const copied = Promise.withResolvers<ClipboardItem>();
      const downloading = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const delivered = Promise.withResolvers<void>();
      let released = false;
      navigator.clipboard.write = async ([item]) => {
        if (item) copied.resolve(item);
      };
      const fetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (
          typeof input !== "string" ||
          !new URL(input, location.origin).pathname.startsWith("/api/assets/")
        ) {
          return fetch(input, init);
        }
        downloading.resolve();
        await release.promise;
        return fetch(input, init);
      };
      const arrayBuffer = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function () {
        const bytes = await arrayBuffer.call(this);
        if (released && this.name === "screenshot.png") delivered.resolve();
        return bytes;
      };
      window.attachmentPaste = {
        copied: copied.promise,
        downloading: downloading.promise,
        finish: async () => {
          released = true;
          release.resolve();
          await delivered.promise;
        },
      };
    });

    await t3.open(source);
    await screen.getByText("first fixture turn complete").waitFor();
    const editor = screen.getByRole("textbox");
    await editor.tap();
    await pasteWideScreenshot(browser);
    await browser.locator('button[aria-label="Preview screenshot.png"]:enabled').waitFor();
    await screen.getByRole("button", "Submit message", { exact: true }).tap();
    const sentImage = browser
      .locator('[data-message-role="user"]')
      .filter({ has: browser.locator('[aria-label="Preview screenshot.png"]') });
    await screen.getByRole("button", "Fork from this response").nth(1).waitFor();
    await sentImage.hover();
    await sentImage.getByRole("button", "Copy message").tap();
    await editor.tap();
    await browser.evaluate(async () => {
      const copied = await window.attachmentPaste.copied;
      const clipboardData = new DataTransfer();
      for (const type of copied.types) {
        clipboardData.setData(type, await (await copied.getType(type)).text());
      }
      document.activeElement?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      await window.attachmentPaste.downloading;
      return null;
    });

    await screen.getByRole("button", "Other work", { exact: false }).tap();
    await screen.getByText("Other thread prompt", { exact: true }).waitFor();
    await browser.evaluate(() => window.attachmentPaste.finish().then(() => null));
    await screen.getByRole("button", "Screenshot work, demo", { exact: true }).press("Enter");
    await screen.getByRole("button", "Thread actions for Screenshot work").waitFor();
    await app.screenshot("pasted-screenshot-after-returning");
    await expect(
      browser
        .locator('[data-chat-composer-form="true"]')
        .getByRole("button", "Image attachment, screenshot.png", { exact: false }),
    ).toBeVisible({ timeout: 3000 });
  },
);
