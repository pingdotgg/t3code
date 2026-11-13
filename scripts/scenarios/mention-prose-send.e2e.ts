import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Enter sends prose after a mention prefix even before search settles",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("mention-prose", { "README.md": "Fixture readme\n" });
    await t3.open();
    const composer = screen.getByRole("textbox");
    await composer.fill("Check @READ");
    await expect(screen.getByRole("option", "README.md", { exact: true })).toBeVisible();
    // One event loop turn keeps the keypress ahead of the debounced search and committed menu refs.
    await browser.evaluate(() => {
      const editor = document.querySelector<
        HTMLElement & {
          editor?: { commands: { insertContent: (text: string) => boolean } };
        }
      >("[data-testid='composer-editor']");
      if (!editor?.editor) throw new Error("Composer editor did not mount");
      editor.editor.commands.insertContent("ME and fix it");
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
      return null;
    });
    await app.screenshot("prose-after-enter");
    await expect(composer).toHaveValue("");
    await expect(screen.getByText("This turn is a replay.", { exact: false })).toBeVisible();
    await app.screenshot("prose-sent");
  },
);
