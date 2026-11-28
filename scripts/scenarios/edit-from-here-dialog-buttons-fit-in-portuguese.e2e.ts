/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Edit from here keeps every dialog button inside the dialog in Portuguese (Brazil)",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Review work", messages: ["Start"] });

    await t3.open("/settings/general");
    await screen.getByLabel("Language", { exact: true }).tap();
    await screen.getByText("Português (Brasil)", { exact: true }).tap();
    await screen.getByLabel("Idioma", { exact: true }).waitFor();

    await t3.open(thread);
    const composer = screen.getByRole("textbox");
    await composer.pressSequentially("Review the changes");
    await browser.keyboard.press("Enter");

    // The seeded message came from the CLI, so only the message sent here offers Edit from here.
    const editFromHere = screen.getByRole("button", "Editar a partir daqui");
    await expect(editFromHere).toHaveCount(1, { timeout: 60_000 });
    await expect(editFromHere).toBeEnabled({ timeout: 60_000 });
    await editFromHere.tap();
    await screen.getByText("Editar a partir daqui?", { exact: true }).waitFor();
    // Measure and capture the settled dialog, not its entrance animation.
    await browser.evaluate(() => {
      const popup = document.querySelector('[data-slot="alert-dialog-popup"]');
      for (const animation of popup?.getAnimations({ subtree: true }) ?? []) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
      }
      return null;
    });

    const footer = await browser.evaluate(() => {
      const popup = document.querySelector<HTMLElement>('[data-slot="alert-dialog-popup"]');
      if (!popup) return null;
      const dialog = popup.getBoundingClientRect();
      const buttons = [
        ...popup.querySelectorAll<HTMLElement>('[data-slot="alert-dialog-footer"] button'),
      ];
      return {
        labels: buttons.map((button) => button.textContent?.trim() ?? ""),
        outside: buttons
          .filter((button) => {
            const box = button.getBoundingClientRect();
            return box.left < dialog.left - 1 || box.right > dialog.right + 1;
          })
          .map((button) => button.textContent?.trim() ?? ""),
      };
    });
    await app.screenshot("edit-from-here-dialog-in-portuguese");
    expect(footer?.labels, "The footer holds the three revert choices").toEqual([
      "Cancelar",
      "Reverter arquivos também",
      "Reverter e manter as alterações",
    ]);
    expect(footer?.outside, "Every footer button sits inside the dialog").toEqual([]);
  },
);
