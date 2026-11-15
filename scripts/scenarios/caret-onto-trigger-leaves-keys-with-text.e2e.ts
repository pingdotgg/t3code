import { expect } from "e2e";
import { test, WEB } from "./t3.ts";

test(
  "Moving the caret onto /mod or @READ leaves editing keys with the text",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Caret control", messages: ["Hello"] });
    await t3.open(thread);
    const composer = screen.getByRole("textbox");
    const typeDraft = async (draft: string) => {
      await composer.press("ControlOrMeta+a");
      await composer.press("Backspace");
      await composer.pressSequentially(draft);
    };
    const caretOntoTrigger = async (draft: string) => {
      await typeDraft(draft);
      await composer.press("ArrowLeft");
      await composer.press("ArrowLeft");
      await composer.press("ArrowLeft");
    };

    await caretOntoTrigger("/mod ab");
    await app.screenshot("caret-on-command");
    await composer.press("ArrowDown");
    await composer.pressSequentially("!");
    await expect(composer).toHaveText("/mod ab!");

    await caretOntoTrigger("/mod ab");
    await composer.press("Shift+Enter");
    await app.screenshot("after-shift-enter");
    await expect(composer).toContainText("/mod");

    await caretOntoTrigger("@READ ab");
    await app.screenshot("caret-on-mention");
    await composer.press("ArrowDown");
    await composer.pressSequentially("!");
    await expect(composer).toHaveText("@READ ab!");

    // A typed trigger opens its list, but Shift+Enter still adds a line.
    await typeDraft("hi @READ");
    await expect(screen.getByRole("listbox")).toBeVisible();
    await composer.press("Shift+Enter");
    await app.screenshot("shift-enter-with-open-list");
    await expect(composer).toContainText("hi @READ");
  },
);
