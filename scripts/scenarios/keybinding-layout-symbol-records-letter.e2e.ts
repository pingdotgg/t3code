import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A layout symbol on a letter key records as that letter, apart from the punctuation key",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("demo");
    await t3.open();

    // Settings opens over the app and the section trip stays client-side, so the recorder
    // loads its keybindings over the connection the sign-in established. The app is still
    // booting while this first tap waits, and a proof's base worktree boots cold.
    await screen.getByRole("button", "Settings").tap({ timeout: 120_000 });
    await screen.getByRole("button", "Keybindings").tap();

    // A custom XKB layout types "." on the physical H key while the dedicated Period key also
    // types ".". Chromium reports both as key=".", so the two chords must record as different
    // shortcuts. The events carry the properties the issue reports, dispatched straight at the
    // recorder input so recording does not depend on where focus landed.
    const press = (code: string) =>
      browser.evaluate((eventCode: string) => {
        const target = document.querySelector<HTMLElement>("[data-keybinding-capture]");
        if (target === null) return false;
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: ".",
            code: eventCode,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        return true;
      }, code);

    await screen.getByRole("button", "Edit shortcut for Terminal: Toggle: Ctrl+J").tap();
    const recorder = screen.getByRole("textbox", "Keybinding for Terminal: Toggle");

    await press("KeyH");
    await expect(recorder).toHaveValue("mod+h");
    await app.screenshot("letter-key-records-as-letter");

    await recorder.tap();
    await press("Period");
    await expect(recorder).toHaveValue("mod+.");
    await app.screenshot("punctuation-key-records-as-symbol");
  },
);
