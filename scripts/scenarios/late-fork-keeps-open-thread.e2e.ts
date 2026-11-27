/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    pendingFork: {
      requested: Promise<void>;
      release: () => Promise<void>;
    };
  }
}

test(
  "A fork that finishes late leaves the thread just opened on screen",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const source = await t3.thread({ project, title: "Fork source", messages: ["first"] });
    await t3.thread({ project, title: "Other work", messages: ["second"] });

    await browser.addInitScript(() => {
      const requested = Promise.withResolvers<void>();
      const replied = Promise.withResolvers<void>();
      let forward = () => {};
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data !== "string" || !data.includes('"thread.fork"')) {
          return send.call(this, data);
        }
        const request = JSON.parse(data);
        if (
          request.tag !== "orchestration.dispatchCommand" ||
          request.payload?.type !== "thread.fork"
        ) {
          return send.call(this, data);
        }
        this.addEventListener("message", (event) => {
          if (
            [JSON.parse(String(event.data))]
              .flat()
              .some(
                (frame) => frame._tag === "Exit" && String(frame.requestId) === String(request.id),
              )
          ) {
            replied.resolve();
          }
        });
        forward = () => send.call(this, data);
        requested.resolve();
      };
      window.pendingFork = {
        requested: requested.promise,
        release: async () => {
          forward();
          await replied.promise;
        },
      };
    });

    await t3.open(source);
    await screen.getByRole("button", "Fork from this response").first().tap();
    await browser.evaluate(() => window.pendingFork.requested.then(() => null));
    await screen.getByRole("button", "Other work", { exact: false }).tap();
    await screen.getByText("second", { exact: true }).waitFor();
    await browser.evaluate(() => window.pendingFork.release().then(() => null));
    await browser
      .locator('[data-testid="sidebar-row-card"]')
      .getByText("Fork source fork", {
        exact: true,
      })
      .waitFor();
    await app.screenshot("after-fork-finishes");
    await expect(screen.getByText("second", { exact: true })).toBeVisible({
      timeout: 3000,
    });
  },
);
