import { ThreadId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

interface SyncHold {
  /** Drops the app's sockets and resolves once the thread's catch-up marker is held. */
  readonly dropAndHold: () => Promise<null>;
  /** Delivers the held marker, so the thread can go live. */
  readonly release: () => null;
}

declare global {
  interface Window {
    __syncHold?: SyncHold;
  }
}

const EARLY = "Too early";
const LATER = "After sync";

test(
  "A thread catching up after a reconnect takes no message until it is live",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Earlier work", messages: ["first"] });
    const userMessages = () =>
      runPromise(
        Effect.gen(function* () {
          const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
          const projection = yield* client["orchestration.getThreadProjection"]({
            threadId: ThreadId.make(thread.threadId),
          });
          return projection.messages
            .filter((message) => message.role === "user")
            .map((message) => message.text);
        }).pipe(Effect.scoped),
      );

    // Stands in for a slow catch-up after the connection drops: the page holds the thread
    // stream's "synchronized" frame, so the thread stays on the copy it already has.
    await browser.addInitScript(() => {
      const sockets = new Set<WebSocket>();
      const held: Array<() => void> = [];
      const threadRequests = new Set<string>();
      let holding = false;
      let onHeld: (() => void) | null = null;
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args: ConstructorParameters<typeof WebSocket>) {
          super(...args);
          this.addEventListener("close", () => sockets.delete(this));
          this.addEventListener("message", (event: MessageEvent) => {
            if (!holding || typeof event.data !== "string") return;
            if (!event.data.includes('"kind":"synchronized"')) return;
            const frame = JSON.parse(event.data) as { readonly requestId?: string | number };
            if (frame.requestId === undefined || !threadRequests.has(String(frame.requestId))) {
              return;
            }
            event.stopImmediatePropagation();
            const data = event.data;
            held.push(() => this.dispatchEvent(new MessageEvent("message", { data })));
            onHeld?.();
          });
        }
        override send(data: Parameters<WebSocket["send"]>[0]) {
          if (typeof data === "string" && data.includes('"tag":"orchestration.subscribeThread"')) {
            threadRequests.add(String((JSON.parse(data) as { readonly id: string | number }).id));
            // Only the app's own connection; the dev server's reload socket stays up.
            sockets.add(this);
          }
          super.send(data);
        }
      };
      window.__syncHold = {
        dropAndHold: () =>
          new Promise<null>((resolve) => {
            holding = true;
            onHeld = () => {
              onHeld = null;
              resolve(null);
            };
            for (const socket of sockets) socket.close();
          }),
        release: () => {
          holding = false;
          for (const deliver of held.splice(0)) deliver();
          return null;
        },
      };
    });

    await t3.open(thread);
    await screen.getByText("first fixture turn complete", { exact: false }).waitFor();
    await browser.evaluate(() => window.__syncHold?.dropAndHold() ?? null);
    // The timeline shows this once the environment is back and the thread is still catching up.
    await screen.getByText("Syncing messages", { exact: false }).waitFor();

    const composer = screen.getByRole("textbox");
    await composer.tap();
    await composer.pressSequentially(EARLY);
    await browser.keyboard.press("Enter");
    await app.screenshot("send-while-syncing");

    await browser.evaluate(() => window.__syncHold?.release() ?? null);
    const submit = screen.getByRole("button", "Submit message");
    await submit.waitFor();
    // Replace whatever the composer still holds, then send once the thread is live.
    for (let index = 0; index < EARLY.length; index += 1) {
      await browser.keyboard.press("Backspace");
    }
    await composer.pressSequentially(LATER);
    await submit.tap();
    // A message sent while the thread was catching up reached the server before this one.
    await expect.poll(userMessages, { timeout: 15_000 }).toEqual(["first", LATER]);
    await app.screenshot("sent-after-sync");
  },
);
