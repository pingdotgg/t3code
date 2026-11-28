/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

interface ReopenGate {
  readonly closed: Promise<void>;
  readonly requested: Promise<void>;
  readonly arm: () => void;
  readonly release: () => Promise<void>;
}

declare global {
  interface Window {
    reopenGate: ReopenGate;
  }
}

test(
  "A browser tab finishing its reopen leaves the newer conversation on screen",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const owner = await t3.thread({ project, title: "Browser owner", messages: ["first"] });
    await t3.thread({
      project,
      title: "Newer conversation",
      messages: ["Stay in this conversation"],
    });

    await browser.addInitScript(() => {
      const closed = Promise.withResolvers<void>();
      const requested = Promise.withResolvers<void>();
      const restored = Promise.withResolvers<void>();
      let hasClosedBrowser = false;
      let armed = false;
      let sendHeld = () => {};
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        setItem.call(this, key, value);
        if (key !== "t3code:closed-views:v2") return;
        const hasBrowser = value.includes('"kind":"browser"');
        if (hasBrowser) closed.resolve();
        else if (hasClosedBrowser) restored.resolve();
        hasClosedBrowser = hasBrowser;
      };
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (!armed || typeof data !== "string") return send.call(this, data);
        const parsed = JSON.parse(data);
        const messages = [parsed].flat();
        const isOpen = (message: { _tag?: string; tag?: string }) =>
          message._tag === "Request" && message.tag === "preview.open";
        const previewOpens = messages.filter(isOpen);
        if (previewOpens.length === 0) return send.call(this, data);
        armed = false;
        const others = messages.filter((message) => !isOpen(message));
        if (others.length > 0) send.call(this, JSON.stringify(others));
        sendHeld = () =>
          send.call(this, Array.isArray(parsed) ? JSON.stringify(previewOpens) : data);
        requested.resolve();
      };
      window.reopenGate = {
        closed: closed.promise,
        requested: requested.promise,
        arm: () => {
          armed = true;
        },
        release: () => {
          sendHeld();
          return restored.promise;
        },
      };
    });

    await t3.open(owner);
    await screen.getByRole("button", "Toggle right panel").tap();
    await screen.getByRole("button", "Browser B").tap();
    await screen.getByRole("button", "Close Browser", { exact: true }).tap();
    await browser.evaluate(async () => {
      await window.reopenGate.closed;
      window.reopenGate.arm();
      return null;
    });

    await browser.keyboard.press("Control+Shift+t");
    await browser.evaluate(async () => {
      await window.reopenGate.requested;
      return null;
    });
    await screen.getByRole("button", "Newer conversation", { exact: false }).tap();
    const newerMessage = screen.getByText("Stay in this conversation", { exact: true });
    await newerMessage.waitFor();
    const newerUrl = await browser.url();
    await browser.evaluate(async () => {
      await window.reopenGate.release();
      return null;
    });

    await app.screenshot("conversation-after-browser-reopens");
    await expect(browser).toHaveURL(newerUrl);
  },
);
