import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A failed first history load keeps sending blocked",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("history-failure");
    await t3.thread({
      project,
      title: "Existing conversation",
      messages: ["Earlier work"],
    });
    await browser.addInitScript(() => {
      const NativeWebSocket = globalThis.WebSocket;
      globalThis.WebSocket = class extends NativeWebSocket {
        override send(data: Parameters<WebSocket["send"]>[0]) {
          const request: unknown = typeof data === "string" ? JSON.parse(data) : null;
          if (
            typeof request === "object" &&
            request !== null &&
            "_tag" in request &&
            request._tag === "Request" &&
            "tag" in request &&
            request.tag === "orchestration.subscribeThread" &&
            "id" in request
          ) {
            queueMicrotask(() =>
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
                            _tag: "EnvironmentAuthorizationError",
                            message: "Thread history unavailable",
                            requiredScope: "orchestration:read",
                          },
                        },
                      ],
                    },
                  }),
                }),
              ),
            );
            return;
          }
          super.send(data);
        }
      };
    });
    await t3.open();
    await screen.getByText("Existing conversation", { exact: false }).first().tap();
    await expect(screen.getByText("Thread history unavailable")).toBeVisible();
    await screen.getByRole("textbox").fill("Wait for the existing conversation");
    await app.screenshot("history-unavailable");
    await expect(
      screen.getByRole("button", /^(Submit message|Message history unavailable)$/),
    ).toBeDisabled();
  },
);
