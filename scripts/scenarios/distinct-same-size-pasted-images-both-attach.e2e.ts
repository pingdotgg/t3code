import { expect } from "e2e";
import type { Browser } from "@e2e-dev/web";

import { test, WEB } from "./t3.ts";

// Two 1x1 PNGs, one red and one blue, that encode to the same number of bytes.
const RED_PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAD0lEQVR4AQEEAPv/AP8AAAMBAQCNHeWCAAAAAElFTkSuQmCC";
const BLUE_PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAD0lEQVR4AQEEAPv/AAAA/wEDAQB8wnTbAAAAAElFTkSuQmCC";

/** Pastes a PNG the way a clipboard image arrives: a new File named image.png. */
const pastePng = (browser: Browser, base64: string) =>
  browser.evaluate((payload: string) => {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([bytes], "image.png", { type: "image/png" }));
    const editor = document.querySelector('[contenteditable="true"]');
    if (!editor) throw new Error("No composer editor to paste into");
    return editor.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, base64);

test(
  "Two different pasted images with the same name, type and size both attach",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Screenshots", messages: ["first"] });
    await t3.open(thread);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();

    const composer = screen.getByRole("textbox");
    await composer.fill("Compare ");
    const chips = composer.getByRole("button", "Image attachment", { exact: false });

    await pastePng(browser, RED_PIXEL);
    await expect(chips).toHaveCount(1);
    await pastePng(browser, BLUE_PIXEL);
    await app.screenshot("after-second-paste");
    await expect(chips).toHaveCount(2);
  },
);
