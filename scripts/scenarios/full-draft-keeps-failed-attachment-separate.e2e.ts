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
      imageRequested: Promise<void>;
      releaseImage: () => void;
    };
  }
}

for (const fullDraft of [true, false]) {
  test(
    fullDraft
      ? "A full new draft keeps a failed screenshot available separately"
      : "A preparing image keeps a failed screenshot separate through draft promotion",
    WEB,
    async ({ t3, browser, screen }) => {
      const project = await t3.project("demo");
      const thread = await t3.thread({ project, title: "Screenshot work", messages: ["first"] });

      await browser.addInitScript(() => {
        const requested = Promise.withResolvers<void>();
        const failure = Promise.withResolvers<void>();
        const imageRequested = Promise.withResolvers<void>();
        const imageRelease = Promise.withResolvers<void>();
        window.pendingFullDraftSend = {
          requested: requested.promise,
          reject: failure.resolve,
          imageRequested: imageRequested.promise,
          releaseImage: imageRelease.resolve,
        };
        const postWorkerMessage = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message, options) {
          if (message?.task?.kind === "fit" && message.task.file?.name === "next.png") {
            imageRequested.resolve();
            void imageRelease.promise.then(() =>
              Reflect.apply(postWorkerMessage, this, [message, options]),
            );
            return;
          }
          Reflect.apply(postWorkerMessage, this, [message, options]);
        };
        const send = WebSocket.prototype.send;
        let intercepted = false;
        WebSocket.prototype.send = function (data) {
          const request = typeof data === "string" ? JSON.parse(data) : null;
          const launch = request?.tag === "orchestration.launchThread";
          const dispatch =
            request?.tag === "orchestration.dispatchCommand" &&
            request.payload?.type === "message.dispatch";
          if (intercepted || (!launch && !dispatch)) {
            return send.call(this, data);
          }
          intercepted = true;
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
                          commandId: request.payload.commandId,
                          ...(launch
                            ? {
                                _tag: "OrchestrationV2ThreadLaunchError",
                                projectId: request.payload.projectId,
                              }
                            : {
                                _tag: "OrchestrationV2DispatchCommandError",
                                commandType: request.payload.type,
                              }),
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
      if (!fullDraft) {
        await screen.getByRole("button", "New thread in demo", { exact: true }).first().tap();
        await expect
          .poll(() => browser.evaluate(() => location.pathname.startsWith("/draft/")))
          .toBe(true);
      }
      await screen.getByRole("textbox").tap();
      await pasteWideScreenshot(browser);
      await browser.locator('button[aria-label="Preview screenshot.png"]:enabled').waitFor();
      await screen.getByRole("button", "Submit message", { exact: true }).tap();
      await browser.evaluate(() => window.pendingFullDraftSend.requested.then(() => null));

      const editor = screen.getByRole("textbox");
      if (fullDraft) await editor.fill("A second message");
      await browser.evaluate(
        async ({ limit, width }) => {
          const canvas = new OffscreenCanvas(width, 2);
          canvas.getContext("2d")!.fillRect(0, 0, width, 2);
          const blob = await canvas.convertToBlob({ type: "image/png" });
          const clipboardData = new DataTransfer();
          for (let index = 0; index < limit; index++) {
            clipboardData.items.add(
              new File([blob], width === 2 ? `fill-${index}.png` : "next.png", {
                type: "image/png",
              }),
            );
          }
          document
            .querySelector('[contenteditable="true"]')!
            .dispatchEvent(
              new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
            );
          return null;
        },
        { limit: fullDraft ? PROVIDER_SEND_TURN_MAX_ATTACHMENTS : 1, width: fullDraft ? 2 : 2200 },
      );
      if (fullDraft) {
        await browser
          .locator(
            `[data-chat-composer-form] button[aria-label="Preview fill-${PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1}.png"]:enabled`,
          )
          .waitFor({ state: "attached" });
      } else {
        await browser.evaluate(() => window.pendingFullDraftSend.imageRequested.then(() => null));
      }

      await browser.evaluate(() => {
        window.pendingFullDraftSend.reject();
        return null;
      });
      await screen.getByText("Message not sent", { exact: true }).waitFor();

      await screen.getByRole("button", "Restore failed draft", { exact: true }).tap();
      await expect(
        screen.getByText("Finish or stash your current draft before restoring.", { exact: true }),
      ).toBeVisible();
      if (fullDraft) await expect(editor).toHaveText(/^A second message(?:\s|$)/);
      await expect(
        browser.locator('[data-chat-composer-form] button[aria-label="Preview screenshot.png"]'),
      ).toHaveCount(0);

      if (fullDraft) {
        await screen.getByRole("link", "T3 Code home", { exact: true }).tap();
        await expect
          .poll(() => browser.evaluate(() => location.pathname.startsWith("/draft/")))
          .toBe(true);
      }
      const expectScreenshotLoaded = () =>
        expect
          .poll(() =>
            browser.evaluate(() => {
              const image = document.querySelector<HTMLImageElement>('img[alt="screenshot.png"]');
              return (image?.naturalWidth ?? 0) > 0;
            }),
          )
          .toBe(true);
      const closePreview = () =>
        screen.getByRole("button", "Close image preview", { exact: true }).tap();
      await screen.getByRole("button", "Preview screenshot.png", { exact: true }).tap();
      await expectScreenshotLoaded();
      await closePreview();

      if (fullDraft) {
        await browser.evaluate(() => {
          history.back();
          return null;
        });
        await editor.waitFor();
        await browser.keyboard.press("Control+s");
        await expect(editor).toHaveText("");
      } else {
        await browser.evaluate(() => {
          window.pendingFullDraftSend.releaseImage();
          return null;
        });
        await browser.locator('button[aria-label="Preview next.png"]:enabled').waitFor();
        await screen.getByRole("button", "Submit message", { exact: true }).tap();
        await expect
          .poll(() => browser.evaluate(() => !location.pathname.startsWith("/draft/")))
          .toBe(true);
      }
      await screen.getByRole("button", "Restore failed draft", { exact: true }).tap();
      await browser
        .locator('[data-chat-composer-form] button[aria-label="Preview screenshot.png"]:enabled')
        .click();
      await expectScreenshotLoaded();
    },
  );
}
