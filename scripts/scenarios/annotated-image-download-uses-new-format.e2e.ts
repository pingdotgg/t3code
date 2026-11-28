/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { runPromise, test, WEB } from "./t3.ts";

// A complete 120×80 single-frame GIF, large enough for the drawing gesture.
const GIF =
  "R0lGODlheABQAPAAAAAAAAAAACH5BAAAAAAALAAAAAB4AFAAAAJxhI+py+0Po5y02ouz3rz7D4biSJbmiabqyrbuC8fyTNf2jef6zvf+DwwKh8Si8YhMKpfMpvMJjUqn1Kr1is1qt9yu9wsOi8fksvmMTqvX7Lb7DY/L5/S6/Y7P6/f8vv8PGCg4SFhoeIiYqLjI2OjYUAAAOw==";

test(
  "Saving an annotated GIF from its open preview downloads a .png file",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Image work", messages: ["Start"] });
    await t3.open(thread);

    const input = '[data-chat-composer-form] input[type="file"]';
    await browser.locator(input).waitFor({ state: "attached" });
    await browser.evaluate(
      ({ input, gif }) => {
        const picker = document.querySelector<HTMLInputElement>(input)!;
        const files = new DataTransfer();
        const bytes = Uint8Array.from(atob(gif), (character) => character.charCodeAt(0));
        files.items.add(new File([bytes], "sample.gif", { type: "image/gif" }));
        picker.files = files.files;
        picker.dispatchEvent(new Event("change", { bubbles: true }));
        return null;
      },
      { input, gif: GIF },
    );

    await screen.getByRole("button", "Preview sample.gif").tap();
    await screen.getByRole("button", "Draw on image").tap();
    const drawing = 'svg[aria-label="Draw on sample.gif"]';
    await browser.locator(drawing).waitFor();
    const point = await browser.evaluate((selector) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { x: rect.x + rect.width / 3, y: rect.y + rect.height / 2 };
    }, drawing);
    await browser.mouse.move(point.x, point.y);
    await browser.mouse.down();
    await browser.mouse.move(point.x + 20, point.y);
    await browser.mouse.up();
    await screen.getByRole("button", "Done", { exact: true }).tap();

    const dialogImage = '[role="dialog"] img';
    await browser.locator(dialogImage).waitFor();
    await screen.getByRole("button", "Close image preview").waitFor();
    await browser.evaluate((selector) => {
      const image = document.querySelector(selector)!;
      const bounds = image.getBoundingClientRect();
      image.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: bounds.x + bounds.width / 2,
          clientY: bounds.y + bounds.height / 2,
        }),
      );
      return null;
    }, dialogImage);
    const save = screen.getByRole("menuitem", "Save image");
    await save.waitFor();
    await app.screenshot("save-edited-image-from-preview");
    const download = await browser.waitForDownload(() => save.tap().then(() => undefined));
    await expect(download.suggestedFilename).toBe("sample.png");
    const bytes = await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFile(download.absolutePath)),
    );
    await expect(Buffer.from(bytes.subarray(0, 8)).toString("hex")).toBe("89504e470d0a1a0a");
  },
);
