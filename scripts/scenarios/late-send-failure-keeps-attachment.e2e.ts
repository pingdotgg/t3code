/// <reference lib="dom" />
import { expect } from "e2e";

import { pasteWideScreenshot } from "./image-compression-hold.ts";
import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    pendingSend: {
      requested: Promise<void>;
      reject: () => void;
    };
  }
}

test(
  "A failed send keeps its screenshot when a new draft is already open",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Screenshot work", messages: ["first"] });

    await browser.addInitScript(() => {
      const requested = Promise.withResolvers<void>();
      const failure = Promise.withResolvers<void>();
      window.pendingSend = { requested: requested.promise, reject: failure.resolve };
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request = typeof data === "string" ? JSON.parse(data) : null;
        if (
          request?.tag !== "orchestration.dispatchCommand" ||
          request.payload?.type !== "message.dispatch"
        ) {
          return send.call(this, data);
        }
        requested.resolve();
        void failure.promise.then(() => {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                _tag: "Exit",
                requestId: request.id,
                exit: {
                  _tag: "Failure",
                  cause: [
                    {
                      _tag: "Fail",
                      error: {
                        _tag: "OrchestrationV2DispatchCommandError",
                        commandId: request.payload.commandId,
                        commandType: request.payload.type,
                        message: "The server could not save the message.",
                      },
                    },
                  ],
                },
              }),
            }),
          );
        });
      };
    });

    await t3.open(thread);
    await screen.getByText("first fixture turn complete", { exact: false }).waitFor();
    await screen.getByRole("textbox").tap();
    await pasteWideScreenshot(browser);
    await browser.locator('button[aria-label="Preview screenshot.png"]:enabled').waitFor();
    await screen.getByRole("button", "Submit message", { exact: true }).tap();
    await browser.evaluate(() => window.pendingSend.requested.then(() => null));

    await screen.getByRole("textbox").fill("A second message");
    await browser.evaluate(() => {
      window.pendingSend.reject();
      return null;
    });
    await screen.getByText("Message not sent", { exact: true }).waitFor();
    await app.screenshot("after-screenshot-send-fails");
    await expect(screen.getByRole("button", "Preview screenshot.png")).toBeVisible({
      timeout: 3000,
    });
  },
);
