/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    heldShortcutUpdates?: (() => void)[];
  }
}

test(
  "Replacing a project action shortcut before the first shortcut streams removes the old rule",
  WEB,
  async ({ t3, browser, screen }) => {
    const project = await t3.project("demo", {
      "t3.json": JSON.stringify({ scripts: [{ name: "Build", command: "echo build" }] }),
    });
    const thread = await t3.thread({ project, title: "Action shortcuts", messages: ["Start"] });
    await browser.setViewport({ width: 1920, height: 1000 });
    await browser.addInitScript(() => {
      const addEventListener = WebSocket.prototype.addEventListener;
      WebSocket.prototype.addEventListener = function (
        this: WebSocket,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type !== "message" || typeof listener !== "function") {
          return addEventListener.call(this, type, listener, options);
        }
        return addEventListener.call(
          this,
          type,
          (event: Event) => {
            const held = window.heldShortcutUpdates;
            const data = (event as MessageEvent).data;
            if (!held || typeof data !== "string") return listener.call(this, event);
            const parsed = JSON.parse(data);
            const messages = [parsed].flat();
            const updates = messages.filter((message) =>
              JSON.stringify(message).includes('"type":"keybindingsUpdated"'),
            );
            if (updates.length === 0) return listener.call(this, event);

            const deliver = (part: readonly unknown[]) =>
              listener.call(
                this,
                new MessageEvent("message", {
                  data: JSON.stringify(Array.isArray(parsed) ? part : part[0]),
                }),
              );
            held.push(() => deliver(updates));
            const rest = messages.filter((message) => !updates.includes(message));
            if (rest.length > 0) deliver(rest);
          },
          options,
        );
      } as typeof WebSocket.prototype.addEventListener;
    });

    await t3.open(thread);
    await screen.getByRole("button", "Choose project action", { exact: true }).tap();
    await screen.getByRole("menuitem", /Build/).tap();
    const actions = screen.getByRole("button", "Script actions", { exact: true });
    const edit = screen.getByRole("button", "Edit Build", { exact: true });
    const dialog = screen.getByRole("dialog", "Edit Action", { exact: true });
    const setShortcut = async (key: string) => {
      await actions.tap();
      await screen.getByRole("menuitem", /^Build/).hover();
      await edit.tap();
      const shortcut = screen.getByRole("textbox", "Keybinding", { exact: true });
      await expect(shortcut).toHaveValue("");
      await shortcut.tap();
      await browser.keyboard.press(key);
      await screen.getByRole("button", "Save changes", { exact: true }).tap();
      await expect(dialog).not.toBeVisible();
    };

    await browser.evaluate(() => {
      window.heldShortcutUpdates = [];
      return null;
    });
    await setShortcut("Control+Alt+7");
    await expect
      .poll(() => browser.evaluate(() => window.heldShortcutUpdates!.length))
      .toBeGreaterThan(0);
    await setShortcut("Control+Alt+8");
    await browser.evaluate(() => {
      for (const deliver of window.heldShortcutUpdates!.splice(0)) deliver();
      delete window.heldShortcutUpdates;
      return null;
    });

    await t3.open("/settings/keybindings");
    await expect(
      screen.getByRole("button", /Edit shortcut for Run Script: Build: .*8$/),
    ).toBeVisible();
    await expect(
      screen.getByRole("button", /Edit shortcut for Run Script: Build: .*7$/),
    ).not.toBeVisible();
  },
);
