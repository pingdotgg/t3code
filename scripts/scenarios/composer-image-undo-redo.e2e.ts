/// <reference lib="dom" />
import { expect } from "e2e";
import type { Browser } from "@e2e-dev/web";

import { test, WEB } from "./t3.ts";

const copySamplePng = (browser: Browser, seed: number) =>
  browser.evaluate(async (colorSeed: number) => {
    const canvas = new OffscreenCanvas(48, 48);
    const context = canvas.getContext("2d")!;
    context.fillStyle = `rgb(${(colorSeed * 53) % 255}, ${(colorSeed * 97) % 255}, 180)`;
    context.fillRect(0, 0, 48, 48);
    const png = await canvas.convertToBlob({ type: "image/png" });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return png.size;
  }, seed);

const UNDO_KEY = "ControlOrMeta+z";
const REDO_KEY = "ControlOrMeta+y";

test(
  "Undo and redo remove and restore pasted composer images and thumbnail removals cleanly",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Image undo", messages: ["first"] });
    await t3.open(thread);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();

    const composer = screen.getByRole("textbox");
    const removeButton = screen.getByRole("button", { name: "Remove image.png" });
    const imageChips = composer.getByRole("button", "Image attachment", { exact: false });
    const unavailableChips = composer.getByRole("button", "Unavailable context", { exact: false });

    // 1. Empty prompt: paste -> Undo removes from shelf -> Redo restores -> click X -> Undo/Redo.
    await composer.click();
    await copySamplePng(browser, 1);
    await browser.keyboard.press("ControlOrMeta+v");
    await expect(removeButton).toHaveCount(1);
    await expect(imageChips).toHaveCount(0);

    await browser.keyboard.press(UNDO_KEY);
    await expect(removeButton).toHaveCount(0);
    await app.screenshot("empty-prompt-after-undo");

    await browser.keyboard.press(REDO_KEY);
    await expect(removeButton).toHaveCount(1);
    await app.screenshot("empty-prompt-after-redo");

    // Unreferenced thumbnail removal via X can also be undone and redone.
    await removeButton.click();
    await expect(removeButton).toHaveCount(0);
    await browser.keyboard.press(UNDO_KEY);
    await expect(removeButton).toHaveCount(1);
    await browser.keyboard.press(REDO_KEY);
    await expect(removeButton).toHaveCount(0);

    // 2. Non-empty prompt: paste adds chip + shelf tile -> Undo removes both -> Redo restores both.
    await composer.click();
    await browser.keyboard.type("Check ");
    await copySamplePng(browser, 2);
    await browser.keyboard.press("ControlOrMeta+v");
    await expect(removeButton).toHaveCount(1);
    await expect(imageChips).toHaveCount(1);

    await browser.keyboard.press(UNDO_KEY);
    await expect(removeButton).toHaveCount(0);
    await expect(imageChips).toHaveCount(0);
    await app.screenshot("non-empty-after-undo");

    await browser.keyboard.press(REDO_KEY);
    await expect(removeButton).toHaveCount(1);
    await expect(imageChips).toHaveCount(1);
    await expect(unavailableChips).toHaveCount(0);

    // 3. Manual Backspace on the chip still leaves the image on the shelf (documented contract).
    await browser.keyboard.press("Backspace");
    await browser.keyboard.press("Backspace");
    await expect(imageChips).toHaveCount(0);
    await expect(removeButton).toHaveCount(1);
    await browser.keyboard.press(UNDO_KEY);
    await expect(imageChips).toHaveCount(1);
    await expect(removeButton).toHaveCount(1);

    // 4. Confirmed X removal of a referenced image: Undo restores both thumbnail and live chip.
    await removeButton.click();
    await screen.getByRole("button", { name: "Confirm" }).click();
    await expect(removeButton).toHaveCount(0);
    await expect(imageChips).toHaveCount(0);

    await browser.keyboard.press(UNDO_KEY);
    await expect(removeButton).toHaveCount(1);
    await expect(imageChips).toHaveCount(1);
    await expect(unavailableChips).toHaveCount(0);
    await app.screenshot("referenced-x-after-undo");

    await browser.keyboard.press(REDO_KEY);
    await expect(removeButton).toHaveCount(0);
    await expect(imageChips).toHaveCount(0);
    await expect(unavailableChips).toHaveCount(0);

    // 5. Undo the removal once more and send to verify the restored image is live and sendable.
    await browser.keyboard.press(UNDO_KEY);
    await expect(removeButton).toHaveCount(1);
    await expect(imageChips).toHaveCount(1);
    await screen.getByRole("button", { name: "Submit message" }).click();
    await expect(removeButton).toHaveCount(0);
    await expect(imageChips).toHaveCount(0);
    await expect(screen.getByText("second fixture turn complete", { exact: false })).toBeVisible();
    await expect(
      screen
        .getByRole("region", { name: "Conversation" })
        .getByRole("button", { name: "Preview image.png" }),
    ).toBeVisible();

    // Post-send Undo in the same thread must not resurrect the sent text, chip, or image.
    await composer.click();
    await browser.keyboard.press(UNDO_KEY);
    await expect(removeButton).toHaveCount(0);
    await expect(imageChips).toHaveCount(0);
    await expect(unavailableChips).toHaveCount(0);
    await expect(composer).toHaveText("");
  },
);
