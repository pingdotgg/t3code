/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "An open stash menu waits for the other tab to finish saving an image before restoring",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const reader = await t3.thread({ project, title: "Reading", messages: ["first"] });
    const writer = await t3.thread({ project, title: "Writing", messages: ["second"] });
    await t3.open(reader);

    const editor = screen.getByTestId("composer-editor");
    await editor.tap();
    await browser.keyboard.press("ControlOrMeta+s");
    const menu = screen.getByRole("list", "Stashed prompts");
    await menu.waitFor();

    await browser.evaluate((threadId) => {
      const frame = document.createElement("iframe");
      frame.id = "stash-writer";
      frame.src = location.pathname.replace(/[^/]+$/, threadId);
      frame.style.cssText =
        "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647";
      document.body.append(frame);
      return null;
    }, writer.threadId);

    const other = browser.frameLocator("#stash-writer");
    const prompt = "Keep this screenshot";
    await other.getByTestId("composer-editor").fill(prompt);
    await browser.evaluate(async () => {
      const frame = document.querySelector<HTMLIFrameElement>("#stash-writer")!;
      const canvas = new OffscreenCanvas(10, 10);
      canvas.getContext("2d")!.fillRect(0, 0, 10, 10);
      const file = new File([await canvas.convertToBlob()], "stash.png", { type: "image/png" });
      const clipboardData = new DataTransfer();
      clipboardData.items.add(file);
      frame
        .contentDocument!.querySelector('[data-testid="composer-editor"]')!
        .dispatchEvent(
          new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
        );
      return null;
    });
    await other.getByRole("button", "Remove stash.png").waitFor();

    await browser.evaluate(() => {
      const writer =
        document.querySelector<HTMLIFrameElement>("#stash-writer")!.contentDocument!.defaultView!;
      const read = writer.FileReader.prototype.readAsDataURL;
      writer.FileReader.prototype.readAsDataURL = function (blob) {
        writer.FileReader.prototype.readAsDataURL = read;
        writer.addEventListener("finish-stash-image", () => read.call(this, blob), { once: true });
      };
      return null;
    });
    await browser.keyboard.press("ControlOrMeta+s");

    await browser.evaluate(() => {
      document.querySelector<HTMLIFrameElement>("#stash-writer")!.hidden = true;
      document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!.focus();
      return null;
    });
    const restore = menu.getByRole("button", `Restore stashed prompt: ${prompt}`, { exact: false });
    await expect(menu.getByText("saving 1 image…")).toBeVisible();
    await app.screenshot("stash-image-still-saving");
    await browser.keyboard.press("Enter");
    await expect(editor).toHaveText("");
    await expect(restore).toBeDisabled();

    await browser.evaluate(() => {
      document
        .querySelector<HTMLIFrameElement>("#stash-writer")!
        .contentWindow!.dispatchEvent(new Event("finish-stash-image"));
      return null;
    });
    await expect(restore).toBeEnabled();
    await restore.tap();
    await expect(editor).toContainText(prompt);
    await expect(screen.getByRole("button", "Remove stash.png")).toBeVisible();
  },
);
