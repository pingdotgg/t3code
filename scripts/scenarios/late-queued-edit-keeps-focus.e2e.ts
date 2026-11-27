/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

declare global {
  interface Window {
    pendingQueueEdit: {
      requested: Promise<void>;
      release: () => Promise<void>;
    };
  }
}

test(
  "Saving a queued edit leaves keyboard focus in the thread just opened",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
        yield* client["server.updateSettings"]({
          patch: { defaultRuntimeMode: "approval-required" },
        });
      }).pipe(Effect.scoped),
    );
    const project = await t3.project("demo");
    const source = await t3.thread({
      project,
      title: "Queued work",
      messages: ["Change the file"],
      model: "approval",
    });
    await t3.thread({ project, title: "Other work", messages: ["Second thread prompt"] });
    const { cli } = makeState(T3_HOME);
    await runPromise(cli(["thread", "send", source.threadId, "Queued message"]));

    await browser.addInitScript(() => {
      const requested = Promise.withResolvers<void>();
      const replied = Promise.withResolvers<void>();
      let forward = () => {};
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data !== "string" || !data.includes('"queued-run.edit"')) {
          return send.call(this, data);
        }
        const request = JSON.parse(data);
        if (
          request.tag !== "orchestration.dispatchCommand" ||
          request.payload?.type !== "queued-run.edit"
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
      window.pendingQueueEdit = {
        requested: requested.promise,
        release: async () => {
          forward();
          await replied.promise;
        },
      };
    });

    await t3.open(source);
    await screen.getByRole("button", "Edit queued message").tap();
    await screen.getByRole("textbox").fill("Edited queued message");
    await screen.getByRole("button", "Update queued message", { exact: false }).tap();
    await browser.evaluate(() => window.pendingQueueEdit.requested.then(() => null));
    await screen.getByRole("button", "Other work", { exact: false }).tap();
    await screen.getByText("Second thread prompt", { exact: true }).tap();
    const focusedComposer = browser.locator(
      '[data-chat-composer-form="true"] [contenteditable="true"]:focus',
    );
    await focusedComposer.waitFor({ state: "hidden" });

    await browser.evaluate(async () => {
      await window.pendingQueueEdit.release();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return null;
    });
    await app.screenshot("other-thread-after-queued-edit-saves");
    await expect(focusedComposer).toBeHidden({
      timeout: 3000,
    });
  },
);
