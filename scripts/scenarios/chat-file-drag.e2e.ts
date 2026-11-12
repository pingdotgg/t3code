import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A draft file reference copies into another thread without changing either draft's text",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const source = await t3.project("drag-source", { "triage-playbook.md": "Source file\n" });
    const target = await t3.project("drag-target", { "triage-playbook.md": "Different file\n" });
    await t3.thread({ project: source, title: "Drag source", messages: ["Source fixture"] });
    await t3.thread({ project: target, title: "Drag target", messages: ["Target fixture"] });
    await t3.open();
    const targetRow = screen.getByRole("button", /^Drag target, /);
    await expect(targetRow).toBeVisible({ timeout: 120_000 });
    await targetRow.tap();
    await screen.getByRole("textbox", "Message Drag target").fill("Existing destination text. ");
    await screen.getByRole("button", /^Drag source, /).tap();
    await screen.getByRole("textbox", "Message Drag source").tap();
    await browser.evaluate(`(() => {
      const editor = document.querySelector('[data-testid="composer-editor"]');
      const data = new DataTransfer();
      data.setData("text/plain", "Read [triage-playbook.md](triage-playbook.md) and follow it.");
      editor?.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
      );
      return true;
    })()`);
    const chip = screen.getByRole("button", "Preview triage-playbook.md");
    await app.screenshot("before-drop");
    await chip.dragTo(targetRow);
    const destination = screen.getByRole("textbox", "Message Drag target");
    await app.screenshot("after-drop");
    await expect(destination).toContainText("triage-playbook.md");
    await expect(destination).toContainText("Existing destination text.");
    await expect(screen.getByRole("button", `Preview ${source}/triage-playbook.md`)).toBeVisible();
    await screen.getByRole("button", /^Drag source, /).tap();
    await expect(screen.getByRole("textbox", "Message Drag source")).toContainText(
      "Read triage-playbook.md and follow it.",
    );
  },
);
