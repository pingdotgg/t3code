/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    finishRemovedImageRead?: () => void;
  }
}

test(
  "A removed unreadable image does not cancel sending the remaining image",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Screenshot work", messages: ["first"] });
    await browser.addInitScript(() => {
      const read = Promise.withResolvers<void>();
      window.finishRemovedImageRead = read.resolve;
      const slice = File.prototype.slice;
      File.prototype.slice = function (...args) {
        const blob = slice.apply(this, args);
        if (this.name === "unreadable.heic") {
          const arrayBuffer = blob.arrayBuffer.bind(blob);
          blob.arrayBuffer = () => read.promise.then(arrayBuffer);
        }
        return blob;
      };
    });

    await t3.open(thread);
    await screen.getByText("first fixture turn complete", { exact: false }).waitFor();
    const composer = screen.getByRole("textbox");
    await composer.fill("What is in this screenshot?");
    await browser.evaluate(async () => {
      const canvas = new OffscreenCanvas(2200, 20);
      canvas.getContext("2d")!.fillRect(0, 0, 2200, 20);
      const screenshot = await canvas.convertToBlob({ type: "image/png" });
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File(["invalid image"], "unreadable.heic", { type: "image/heic" }),
      );
      clipboardData.items.add(new File([screenshot], "screenshot.png", { type: "image/png" }));
      document
        .querySelector('[contenteditable="true"]')!
        .dispatchEvent(
          new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
        );
      return null;
    });
    const removeUnreadable = screen.getByRole("button", "Remove unreadable.heic");
    await removeUnreadable.tap();
    await removeUnreadable.waitFor({ state: "hidden" });
    await screen.getByRole("button", "Remove screenshot.png").waitFor();
    await composer.press("Enter");
    await screen.getByRole("button", "Sending when ready").waitFor();
    await browser.evaluate(() => {
      window.finishRemovedImageRead!();
      return null;
    });
    await screen.getByText("Preparing", { exact: true }).waitFor({ state: "hidden" });
    await app.screenshot("remaining-image-after-preparation");

    await expect(
      browser
        .locator('[data-message-role="user"]:has([aria-label="Preview screenshot.png"])')
        .filter({ hasText: "What is in this screenshot?" }),
    ).toBeVisible();
  },
);
