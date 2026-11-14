import { expect } from "e2e";

import {
  finishImageCompression,
  holdImageCompression,
  pasteWideScreenshot,
} from "./image-compression-hold.ts";
import { test, WEB } from "./t3.ts";

test(
  "A thread draft discarded while its pasted image compresses stays discarded and can be restored",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await holdImageCompression(browser);
    const project = await t3.project("demo");
    const source = await t3.thread({ project, title: "Screenshot work", messages: ["first"] });
    await t3.thread({ project, title: "Other work", messages: ["first"] });
    await t3.open(source);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();

    const composer = screen.getByRole("textbox");
    await composer.fill("Half-written prompt");
    await pasteWideScreenshot(browser);
    // The sidebar offers a thread's discard only once that thread is no longer open.
    await screen.getByRole("button", "Other work", { exact: false }).tap();
    // The row's controls show on hover, over its labels.
    await screen.getByRole("button", "Screenshot work", { exact: false }).hover();
    await screen.getByRole("button", "Discard draft").tap();
    await finishImageCompression(browser);
    await app.screenshot("after-compression");
    await expect(screen.getByRole("img", "Unsent draft")).toBeHidden();

    await screen.getByRole("button", "undo", { exact: false }).tap();
    await screen.getByRole("button", "Screenshot work", { exact: false }).tap();
    await app.screenshot("after-undo");
    await expect(composer).toContainText("Half-written prompt");
  },
);
