/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test("Eraser skips blank space", WEB, async ({ t3, app, browser, screen }) => {
  const project = await t3.project("demo");
  const thread = await t3.thread({ project, title: "Annotate screenshot", messages: ["Start"] });
  await t3.open(thread);
  await browser.locator('[data-testid="composer-editor"]').waitFor();

  await browser.evaluate(async () => {
    const image = document.createElement("canvas");
    image.width = image.height = 320;
    const context = image.getContext("2d")!;
    context.fillStyle = "#111";
    context.fillRect(0, 0, image.width, image.height);
    const blob = await new Promise<Blob | null>((resolve) => image.toBlob(resolve));
    if (!blob) throw new Error("Could not create the attachment image");
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([blob], "screenshot.png", { type: "image/png" }));
    return document
      .querySelector('[data-testid="composer-editor"]')!
      .dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
  });
  await screen.getByRole("button", "Preview screenshot.png", { exact: true }).tap();
  await screen.getByRole("button", "Draw on image", { exact: true }).tap();

  const surface = screen.getByRole("img", "Draw on screenshot.png");
  const box = await surface.boundingBox();
  if (!box) throw new Error("The drawing surface is missing");
  const move = (x: number, y: number) =>
    browser.mouse.move(box.x + box.width * x, box.y + box.height * y);
  await move(0.2, 0.2);
  await browser.mouse.down();
  await move(0.4, 0.4);
  await move(0.6, 0.6);
  await move(0.8, 0.8);
  await browser.mouse.up();
  const stroke = browser.locator('svg[aria-label="Draw on screenshot.png"] > path');
  await stroke.waitFor();

  await screen.getByRole("button", "Erase a stroke (E)", { exact: true }).tap();
  await move(0.3, 0.7);
  await browser.mouse.down();
  await browser.mouse.up();

  await app.screenshot("after-erasing-blank-space");
  await expect(stroke).toBeVisible();

  await move(0.5, 0.5 + 7 / box.height);
  await browser.mouse.down();
  await browser.mouse.up();
  await expect(stroke).toHaveCount(0);
});
