/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    firstModelStartFailure?: Promise<() => void>;
  }
}

test(
  "A late model start failure leaves a different prompt sendable",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Project work", messages: ["Start"] });
    await browser.addInitScript(() => {
      const pending = Promise.withResolvers<() => void>();
      window.firstModelStartFailure = pending.promise;
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
            initialMessage?: { text: string };
          };
        } = JSON.parse(data);
        const payload = request.payload;
        if (
          request._tag !== "Request" ||
          request.tag !== "orchestration.launchThread" ||
          payload?.modelSelection?.model !== "showcase" ||
          payload.initialMessage?.text !== "First comparison"
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
                        message: "First comparison launch outcome unknown.",
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
    const send = async (prompt: string) => {
      await composer.fill(prompt);
      await composer.press("Enter");
    };
    await send("First comparison");
    await browser.evaluate(() => window.firstModelStartFailure!.then(() => null));
    await send("Second comparison");
    await screen.getByText("Started 2 threads in background", { exact: true }).waitFor();

    await browser.evaluate(async () => {
      const fail = await window.firstModelStartFailure!;
      fail();
      return null;
    });
    await screen.getByText("First comparison launch outcome unknown.", { exact: true }).waitFor();
    await send("Third comparison");
    const thirdThreads = screen.getByRole("button", /^Third comparison(?:,|$)/);
    await thirdThreads.first().waitFor();
    await app.screenshot("third-comparison-threads");
    await expect.poll(() => thirdThreads.count()).toBe(2);
  },
);
