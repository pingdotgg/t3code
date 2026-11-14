import { expect } from "e2e";

import {
  finishImageCompression,
  holdImageCompression,
  pasteWideScreenshot,
} from "./image-compression-hold.ts";
import { test, WEB } from "./t3.ts";

test(
  "A new-thread draft discarded while its pasted image compresses can be restored",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await holdImageCompression(browser);
    // The sidebar lists drafts only alongside a thread list.
    const project = await t3.project("demo");
    await t3.thread({ project, title: "Earlier work", messages: ["first"] });
    await t3.open();

    const composer = screen.getByRole("textbox");
    await composer.fill("Half-written prompt");
    // The sidebar lists the open draft only when it already had content on arrival.
    await screen.getByRole("button", "Earlier work", { exact: false }).tap();
    await screen.getByTestId("sidebar-draft-row").tap();
    await expect(composer).toContainText("Half-written prompt");
    await pasteWideScreenshot(browser);
    await screen.getByRole("button", "Discard draft").tap();
    await finishImageCompression(browser);

    await screen.getByRole("button", "undo", { exact: false }).tap();
    await app.screenshot("after-undo");
    // Discarding the open draft moved the route to a fresh one; the restored draft is listed.
    const restored = screen.getByTestId("sidebar-draft-row");
    await expect(restored).toBeVisible();
    await restored.tap();
    await expect(composer).toContainText("Half-written prompt");
  },
);
