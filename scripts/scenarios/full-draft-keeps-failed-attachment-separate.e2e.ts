/// <reference lib="dom" />
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { expect } from "e2e";

import { pasteWideScreenshot } from "./image-compression-hold.ts";
import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    pendingFullDraftSend: {
      requested: Promise<void>;
      reject: () => void;
    };
  }
}

test(
  "A full new draft keeps a failed screenshot available separately",
  WEB,
  async ({ t3, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Screenshot work", messages: ["first"] });

    await browser.addInitScript(() => {
      const requested = Promise.withResolvers<void>();
      const failure = Promise.withResolvers<void>();
      window.pendingFullDraftSend = { requested: requested.promise, reject: failure.resolve };
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
    await browser.evaluate(() => window.pendingFullDraftSend.requested.then(() => null));

    const editor = screen.getByRole("textbox");
    await editor.fill("A second message");
    await browser.evaluate(async (limit) => {
      const canvas = new OffscreenCanvas(2, 2);
      canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const clipboardData = new DataTransfer();
      for (let index = 0; index < limit; index++) {
        clipboardData.items.add(new File([blob], `fill-${index}.png`, { type: "image/png" }));
      }
      document
        .querySelector('[contenteditable="true"]')!
        .dispatchEvent(
          new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
        );
      return null;
    }, PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
    await browser
      .locator(
        `[data-chat-composer-form] button[aria-label="Preview fill-${PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1}.png"]:enabled`,
      )
      .waitFor({ state: "attached" });

    await browser.evaluate(() => {
      window.pendingFullDraftSend.reject();
      return null;
    });
    await screen.getByText("Message not sent", { exact: true }).waitFor();

    await screen.getByRole("button", "Restore failed draft", { exact: true }).tap();
    await expect(
      screen.getByText("Finish or stash your current draft before restoring.", { exact: true }),
    ).toBeVisible();
    await expect(editor).toHaveText(/^A second message(?:\s|$)/);
    await expect(
      browser.locator('[data-chat-composer-form] button[aria-label="Preview screenshot.png"]'),
    ).toHaveCount(0);

    await screen.getByRole("button", "Preview screenshot.png", { exact: true }).tap();
    await expect
      .poll(() =>
        browser.evaluate(() => {
          const image = document.querySelector<HTMLImageElement>('img[alt="screenshot.png"]');
          return (image?.naturalWidth ?? 0) > 0;
        }),
      )
      .toBe(true);

    await screen.getByRole("button", "Close image preview", { exact: true }).tap();
    await browser.keyboard.press("Control+s");
    await expect(editor).toHaveText("");
    await screen.getByRole("button", "Restore failed draft", { exact: true }).tap();
    await expect(
      browser.locator(
        '[data-chat-composer-form] button[aria-label="Preview screenshot.png"]:enabled',
      ),
    ).toBeVisible();
  },
);
