import { ThreadId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

const HOLD_FLAG = "scenario-hold-thread-sync";

interface SyncHold {
  readonly held: () => number;
  readonly release: () => void;
}

const sleep = (ms: number) => runPromise(Effect.sleep(ms));

test(
  "A thread shown from its cached copy takes no message until it has caught up",
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

    // Stands in for a slow catch-up after a reload: the page holds the thread stream's
    // "synchronized" frame, so the thread stays on its cached copy until the scenario lets go.
    await browser.addInitScript((flag: string) => {
      if (sessionStorage.getItem(flag) !== "1") return;
      const held: Array<() => void> = [];
      let holding = true;
      const threadRequests = new Set<string>();
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args: ConstructorParameters<typeof WebSocket>) {
          super(...args);
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
          });
        }
        override send(data: Parameters<WebSocket["send"]>[0]) {
          if (typeof data === "string" && data.includes('"tag":"orchestration.subscribeThread"')) {
            threadRequests.add(String((JSON.parse(data) as { readonly id: string | number }).id));
          }
          super.send(data);
        }
      };
      const hold: SyncHold = {
        held: () => held.length,
        release: () => {
          holding = false;
          for (const deliver of held.splice(0)) deliver();
        },
      };
      (window as unknown as { __syncHold: SyncHold }).__syncHold = hold;
    }, HOLD_FLAG);

    await t3.open(thread);
    await screen.getByText("first fixture turn complete", { exact: false }).waitFor();
    // The client saves its thread cache at most every 10 seconds; let it save this thread.
    await sleep(11_000);

    await browser.evaluate((flag: string) => {
      sessionStorage.setItem(flag, "1");
      return null;
    }, HOLD_FLAG);
    await browser.reload();
    await screen.getByText("first fixture turn complete", { exact: false }).waitFor();
    for (let attempt = 0; ; attempt += 1) {
      const held = await browser.evaluate(
        () => (window as unknown as { __syncHold?: SyncHold }).__syncHold?.held() ?? 0,
      );
      if (held > 0) break;
      if (attempt >= 100) throw new Error("The thread stream never sent its catch-up marker.");
      await sleep(100);
    }

    const composer = screen.getByRole("textbox");
    await composer.tap();
    await composer.pressSequentially("Next step");
    await browser.keyboard.press("Enter");
    await app.screenshot("send-while-syncing");
    // A send from this point reaches the server well inside this window on a local stack.
    await sleep(2_000);
    expect(await userMessages()).toEqual(["first"]);

    await browser.evaluate(() => {
      (window as unknown as { __syncHold?: SyncHold }).__syncHold?.release();
      return null;
    });
    const submit = screen.getByRole("button", "Submit message");
    await submit.waitFor();
    await submit.tap();
    await expect.poll(userMessages, { timeout: 15_000 }).toEqual(["first", "Next step"]);
    await app.screenshot("sent-after-sync");
  },
);
