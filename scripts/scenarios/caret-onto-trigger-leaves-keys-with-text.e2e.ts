import { expect } from "e2e";
import { test, WEB } from "./t3.ts";

test(
  "Moving the caret onto /mod leaves editing keys with the text",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Caret control", messages: ["Hello"] });
    await t3.open(thread);
    const composer = screen.getByRole("textbox");

    await composer.pressSequentially("/mod ab");
    await composer.press("ArrowLeft");
    await composer.press("ArrowLeft");
    await composer.press("ArrowLeft");
    await app.screenshot("caret-on-command");
    await composer.press("ArrowDown");
    await composer.pressSequentially("!");
    await expect(composer).toHaveText("/mod ab!");

    await composer.press("ControlOrMeta+a");
    await composer.press("Backspace");
    await composer.pressSequentially("/mod ab");
    await composer.press("ArrowLeft");
    await composer.press("ArrowLeft");
    await composer.press("ArrowLeft");
    await expect(screen.getByRole("listbox")).toBeHidden();
    await composer.press("Shift+Enter");
    await composer.pressSequentially("next");
    await app.screenshot("shift-enter-with-closed-list");
    await expect(composer).toHaveText("/mod next ab");
    await expect(browser.locator('[role="textbox"] > p')).toHaveCount(2);

    // A typed trigger opens its list, but Shift+Enter still adds a line.
    await composer.press("ControlOrMeta+a");
    await composer.press("Backspace");
    await composer.pressSequentially("hi @READ");
    await expect(screen.getByRole("option").first()).toBeVisible();
    await composer.press("Shift+Enter");
    await composer.pressSequentially("next");
    await app.screenshot("shift-enter-with-open-list");
    await expect(composer).toHaveText("hi @READ next");
    await expect(browser.locator('[role="textbox"] > p')).toHaveCount(2);

    for (const key of ["Enter", "Tab"]) {
      await composer.press("ControlOrMeta+a");
      await composer.press("Backspace");
      await composer.pressSequentially("hi @READ");
      await expect(screen.getByRole("option").first()).toBeVisible();
      await composer.press(key);
      await expect(screen.getByRole("listbox")).toBeHidden();
      await expect(composer).not.toContainText("@READ");
    }

    await composer.press("ControlOrMeta+a");
    await composer.press("Backspace");
    await composer.pressSequentially("hi /m");
    await expect(screen.getByRole("option").first()).toBeVisible();
    await composer.press("Escape");
    await composer.pressSequentially("o");
    await expect(screen.getByRole("listbox")).toBeHidden();
    await composer.press("ArrowLeft");
    await composer.press("ArrowRight");
    await composer.pressSequentially("d");
    await expect(screen.getByRole("listbox")).toBeHidden();
    await composer.press("Home");
    await composer.press("End");
    await expect(screen.getByRole("listbox")).toBeHidden();
    await composer.pressSequentially("e");
    await app.screenshot("escape-leave-return-edit");
    await expect(screen.getByRole("option").first()).toBeVisible();
  },
);
