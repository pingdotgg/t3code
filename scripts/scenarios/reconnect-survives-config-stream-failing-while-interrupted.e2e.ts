import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { runPromise, test, WEB } from "./t3.ts";

interface Fault {
  readonly failConfigStreamWhileInterrupted: () => boolean;
}

test(
  "The app reconnects after its config stream fails while interrupted",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({
      project,
      title: "Earlier work",
      messages: ["Print the JSON"],
      model: "command-output",
    });
    // Injected fault: the page hands the app one server frame that ends the config
    // subscription with a typed failure and an interruption in the same cause.
    await browser.addInitScript(() => {
      let deliver: (() => void) | null = null;
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        override send(data: Parameters<WebSocket["send"]>[0]) {
          if (typeof data === "string" && data.includes('"tag":"subscribeServerConfig"')) {
            const requestId = (JSON.parse(data) as { id: number | string }).id;
            deliver = () =>
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: JSON.stringify({
                    _tag: "Exit",
                    requestId,
                    exit: {
                      _tag: "Failure",
                      cause: [
                        {
                          _tag: "Fail",
                          error: {
                            _tag: "KeybindingsConfigParseError",
                            configPath: "/demo/keybindings.json",
                            detail: "Injected failure.",
                          },
                        },
                        { _tag: "Interrupt", fiberId: 1 },
                      ],
                    },
                  }),
                }),
              );
          }
          super.send(data);
        }
      };
      (window as unknown as { __fault: Fault }).__fault = {
        failConfigStreamWhileInterrupted: () => {
          deliver?.();
          return deliver !== null;
        },
      };
    });
    await browser.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await t3.open(thread);

    const reply = screen.getByText("The command printed one JSON line.");
    await expect(reply.first()).toBeVisible();
    await app.screenshot("1-connected");

    const delivered = await browser.evaluate(() =>
      (window as unknown as { __fault: Fault }).__fault.failConfigStreamWhileInterrupted(),
    );
    expect(delivered).toBe(true);
    // A live loop reconnects well within each wait; a dead one never does.
    await runPromise(Effect.sleep("5 seconds"));
    await app.screenshot("2-five-seconds-after-the-failure");

    await screen.getByRole("textbox").fill("Are you still there?");
    await screen.getByRole("textbox").press("Enter");
    await runPromise(Effect.sleep("3 seconds"));
    await app.screenshot("3-after-pressing-enter");
    await expect(reply.nth(1)).toBeVisible();
  },
);
