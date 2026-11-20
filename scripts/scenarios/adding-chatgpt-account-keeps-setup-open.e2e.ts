/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    chatGptAccountSave?: {
      readonly started: Promise<void>;
      readonly release: () => void;
    };
  }
}

test(
  "Escape leaves ChatGPT account setup open while the account is being added",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    await browser.addInitScript(() => {
      const gate = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      window.chatGptAccountSave = { started: started.promise, release: gate.resolve };
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data !== "string") return send.call(this, data);
        const parsed = JSON.parse(data);
        const messages = [parsed].flat();
        const accountSave = (message: {
          _tag?: string;
          tag?: string;
          payload?: { patch?: { providerInstances?: Record<string, { displayName?: string }> } };
        }) =>
          message?._tag === "Request" &&
          message.tag === "server.updateSettings" &&
          Object.values(message.payload?.patch?.providerInstances ?? {}).some(
            (instance) => instance.displayName === "ChatGPT - Slow account",
          );
        const saves = messages.filter(accountSave);
        if (saves.length === 0) return send.call(this, data);
        const other = messages.filter((message) => !saves.includes(message));
        if (other.length > 0) send.call(this, JSON.stringify(other));
        started.resolve();
        void gate.promise.then(() =>
          send.call(this, Array.isArray(parsed) ? JSON.stringify(saves) : data),
        );
      };
    });
    await t3.open("/settings/providers?instanceId=codex");
    await screen.getByRole("button", "Add provider", { exact: true }).first().tap();
    const addProvider = screen.getByRole("dialog", "Add provider", { exact: true });
    await addProvider.getByRole("radio", "Codex", { exact: true }).tap();
    await addProvider.getByRole("button", "Continue with ChatGPT", { exact: true }).tap();

    const setup = screen.getByRole("dialog", "Add ChatGPT account", { exact: true });
    await setup.getByRole("textbox", "Account name", { exact: true }).fill("Slow account");
    try {
      await setup.getByRole("button", "Continue", { exact: true }).tap();
      const adding = browser
        .locator('[data-slot="dialog-popup"][data-open]')
        .getByRole("button", "Adding account…", { exact: true });
      await adding.waitFor();
      await browser.evaluate(async () => {
        await window.chatGptAccountSave!.started;
        return null;
      });
      await browser.keyboard.press("Escape");
      await app.screenshot("escape-during-account-creation");
      expect(
        await adding.isVisible(),
        "ChatGPT account setup stays open while adding the account",
      ).toBe(true);
    } finally {
      await browser.evaluate(() => {
        window.chatGptAccountSave?.release();
        return null;
      });
    }
  },
);
