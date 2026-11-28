/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    releaseOldThemeRead: () => void;
  }
}

test(
  "An earlier theme file cannot become the draft after its replacement is rejected",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    await t3.open("/settings/appearance");
    await screen.getByRole("button", "Add theme", { exact: true }).tap();
    const dialog = screen.getByRole("dialog", "Add a theme");

    await browser.evaluate(() => {
      const target = document.querySelector('input[type="file"]')?.parentElement;
      if (!target) throw new Error("No theme file drop target");

      const gate = Promise.withResolvers<void>();
      const theme = JSON.stringify({
        version: 1,
        name: "Earlier theme",
        appearance: "dark",
        colors: { accent: "#734ee4" },
      });
      const first = new File([theme], "earlier.json", { type: "application/json" });
      const text = File.prototype.text;
      File.prototype.text = function () {
        if (this.name === first.name) return gate.promise.then(() => theme);
        return text.call(this);
      };
      window.releaseOldThemeRead = gate.resolve;

      const drop = (file: File) => {
        const files = new DataTransfer();
        files.items.add(file);
        target.dispatchEvent(
          new DragEvent("drop", { dataTransfer: files, bubbles: true, cancelable: true }),
        );
      };
      drop(first);
      drop(new File([" ".repeat(300_000)], "replacement.json", { type: "application/json" }));
      return null;
    });

    await dialog.getByText(/That file is/).waitFor();
    await browser.evaluate(async () => {
      window.releaseOldThemeRead();
      // Let the earlier file response and its React update reach the dialog.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return null;
    });
    await app.screenshot("dialog-after-earlier-theme-read-finishes");
    await expect(dialog.getByRole("button", "Add theme", { exact: true })).toBeDisabled();
  },
);
