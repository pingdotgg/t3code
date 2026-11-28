import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "An unpinned sidebar card's Pin button is reachable and usable by keyboard with the pointer away",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const open = await t3.thread({ project, title: "Keep this thread open", messages: ["first"] });
    await t3.thread({ project, title: "Pin with keyboard", messages: ["first"] });
    await t3.thread({ project, title: "Other card", messages: ["first"] });
    await t3.open(open);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();

    // Pointer rests on the composer, away from every sidebar card.
    await screen.getByRole("textbox").tap();
    const card = screen.getByRole("button", "Pin with keyboard", { exact: false });
    await card.focus();
    await browser.keyboard.press("Tab");
    await app.screenshot("pin-button-focused");
    await expect(card.getByRole("button", "Pin thread")).toBeFocused();

    await browser.keyboard.press("Enter");
    await app.screenshot("after-keyboard-pin");
    await expect(screen.getByRole("button", "Unpin thread")).toBeVisible();
  },
);
