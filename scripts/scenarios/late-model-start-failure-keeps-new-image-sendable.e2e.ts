/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    firstImageLaunchFailure?: Promise<() => void>;
  }
}

test(
  "A late model start failure leaves a different image-only prompt sendable",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Project work", messages: ["Start"] });
    await browser.addInitScript(() => {
      const pending = Promise.withResolvers<() => void>();
      window.firstImageLaunchFailure = pending.promise;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (this: WebSocket, data) {
        if (typeof data !== "string") return send.call(this, data);
        const request: {
          _tag?: string;
          tag?: string;
          id?: string;
          payload?: {
            commandId: string;
            projectId: string;
            modelSelection?: { model: string };
          };
        } = JSON.parse(data);
        const payload = request.payload;
        if (
          request._tag !== "Request" ||
          request.tag !== "orchestration.launchThread" ||
          payload?.modelSelection?.model !== "showcase"
        ) {
          return send.call(this, data);
        }
        // Report the older request's failure after the newer request actually starts on the server.
        WebSocket.prototype.send = send;
        pending.resolve(() => {
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
                        _tag: "OrchestrationV2ThreadLaunchError",
                        commandId: payload.commandId,
                        projectId: payload.projectId,
                        message: "First image launch outcome unknown.",
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
    await screen.getByRole("button", "New thread in demo", { exact: true }).tap();
    const picker = browser.locator("[data-chat-provider-model-picker]");
    await picker.tap();
    await screen.getByPlaceholder("Search models...").fill("Multi turn");
    await browser.keyboard.down("Shift");
    await screen.getByRole("option", /^Multi turn/).tap();
    await browser.keyboard.up("Shift");
    await browser.keyboard.press("Escape");

    const composer = screen.getByRole("textbox");
    const imagePreview = (name: string) =>
      screen.getByRole("button", `Preview ${name}`, { exact: true });
    const sendAttachedImage = async (name: string) => {
      await expect(composer).toHaveText("");
      await expect(composer.getByRole("button", "Image attachment", { exact: false })).toHaveCount(
        0,
      );
      await expect(imagePreview(name)).toBeVisible();
      await composer.press("Enter");
    };
    const sendImage = async (name: string, color: string) => {
      await composer.tap();
      await browser.evaluate(
        ({ name, color }) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d");
          const editor = document.querySelector('[contenteditable="true"]');
          if (!context || !editor) throw new Error("Could not paste an image into the composer");
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const png = atob(canvas.toDataURL("image/png").split(",")[1]!);
          const bytes = Uint8Array.from(png, (byte) => byte.charCodeAt(0));
          const clipboardData = new DataTransfer();
          clipboardData.items.add(new File([bytes], name, { type: "image/png" }));
          editor.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
          );
          return null;
        },
        { name, color },
      );

      await imagePreview(name).waitFor();
      // Removing the inline reference leaves the image attached and the prompt text empty.
      await composer.press("ControlOrMeta+a");
      await composer.press("Backspace");
      await sendAttachedImage(name);
    };

    const bothStarted = screen.getByRole("dialog", "Started 2 threads in background", {
      exact: true,
    });
    await sendImage("first.png", "red");
    await browser.evaluate(() => window.firstImageLaunchFailure!.then(() => null));
    await sendImage("second.png", "green");
    await bothStarted.getByRole("button", "Dismiss notification", { exact: true }).tap();
    await bothStarted.waitFor({ state: "detached" });

    await browser.evaluate(async () => {
      const fail = await window.firstImageLaunchFailure!;
      fail();
      return null;
    });
    await screen.getByText("First image launch outcome unknown.", { exact: true }).waitFor();
    await sendImage("third.png", "blue");
    await expect(bothStarted).toBeVisible();
    await app.screenshot("replacement-image-started-both-threads");

    await screen.getByRole("button", "Restore prompt", { exact: true }).tap();
    await sendAttachedImage("first.png");
    const warning =
      "The previous request may have started. Open its thread to check before sending again.";
    const retainedLaunch = screen
      .getByRole("dialog", "Could not start showcase", { exact: true })
      .filter({ hasText: warning });
    await expect(retainedLaunch.getByRole("button", "Open thread", { exact: true })).toBeVisible();
  },
);
