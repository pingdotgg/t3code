/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    unchangedDraftWorkspaceDefaultHold: {
      readonly requested: Promise<void>;
      readonly release: () => void;
    };
  }
}

test(
  "An unchanged first message sends after workspace defaults load",
  WEB,
  async ({ t3, browser, screen }) => {
    const project = await t3.project("demo", { "t3.json": '{"defaultThreadEnvMode":"local"}' });
    await t3.thread({ project, title: "Earlier work", messages: ["first"] });

    await browser.addInitScript(() => {
      const requested = Promise.withResolvers<void>();
      let sendHeld = () => {};
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data !== "string" || !data.includes('"relativePath":"t3.json"')) {
          return send.call(this, data);
        }
        const parsed = JSON.parse(data);
        const messages = [parsed].flat();
        const isProjectFile = (frame: { tag?: string; payload?: { relativePath?: string } }) =>
          frame.tag === "projects.readFile" && frame.payload?.relativePath === "t3.json";
        const held = messages.filter(isProjectFile);
        if (held.length === 0) return send.call(this, data);
        const others = messages.filter((frame) => !isProjectFile(frame));
        if (others.length > 0) send.call(this, JSON.stringify(others));
        sendHeld = () => send.call(this, Array.isArray(parsed) ? JSON.stringify(held) : data);
        requested.resolve();
      };
      window.unchangedDraftWorkspaceDefaultHold = {
        requested: requested.promise,
        release: () => sendHeld(),
      };
    });
    await t3.open();

    await browser.evaluate(async () => {
      await window.unchangedDraftWorkspaceDefaultHold.requested;
      return null;
    });
    const composer = screen.getByRole("textbox");
    await composer.fill("First prompt");
    await composer.press("Enter");
    await composer.press("ArrowLeft");
    await browser.evaluate(() => {
      window.unchangedDraftWorkspaceDefaultHold.release();
      return null;
    });

    await expect(
      browser.locator('[data-message-role="user"]').filter({ hasText: "First prompt" }),
    ).toBeVisible();
  },
);
