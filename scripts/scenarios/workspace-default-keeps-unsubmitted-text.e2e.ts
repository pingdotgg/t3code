/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    workspaceDefaultHold: {
      readonly requested: Promise<void>;
      readonly release: () => Promise<void>;
    };
  }
}

test(
  "A pending send does not submit text typed while workspace defaults load",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", { "t3.json": '{"defaultThreadEnvMode":"local"}' });
    await t3.thread({ project, title: "Earlier work", messages: ["first"] });

    await browser.addInitScript(() => {
      const requested = Promise.withResolvers<void>();
      const replied = Promise.withResolvers<void>();
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
        this.addEventListener("message", (event) => {
          if (
            [JSON.parse(String(event.data))]
              .flat()
              .some(
                (frame) => frame._tag === "Exit" && String(frame.requestId) === String(held[0].id),
              )
          ) {
            replied.resolve();
          }
        });
        sendHeld = () => send.call(this, Array.isArray(parsed) ? JSON.stringify(held) : data);
        requested.resolve();
      };
      window.workspaceDefaultHold = {
        requested: requested.promise,
        release: async () => {
          sendHeld();
          await replied.promise;
        },
      };
    });
    await t3.open();

    await browser.evaluate(async () => {
      await window.workspaceDefaultHold.requested;
      return null;
    });
    const composer = screen.getByRole("textbox");
    await composer.fill("First prompt");
    await composer.press("Enter");
    await composer.fill("Unsubmitted replacement");
    await browser.evaluate(async () => {
      await window.workspaceDefaultHold.release();
      return null;
    });

    await expect(
      screen.getByText("Draft changed while preparing this message. Review it and send again."),
    ).toBeVisible();
    await app.screenshot("after-workspace-default-loads");
    await expect(composer).toHaveText("Unsubmitted replacement");
  },
);
