/// <reference lib="dom" />
import type { RuntimeMode } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

declare global {
  interface Window {
    pendingQueueEdit: {
      requested: Promise<void>;
      release: () => Promise<string>;
    };
  }
}

test(
  "Saving a queued edit leaves keyboard focus in the thread just opened",
  WEB,
  async ({ t3, app, browser, screen }) => {
    // Returns the previous mode so the shared scenario server can be put back afterwards.
    const setRuntimeMode = (mode: RuntimeMode) =>
      runPromise(
        Effect.gen(function* () {
          const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
          const previous = (yield* client["server.getSettings"]({})).defaultRuntimeMode;
          yield* client["server.updateSettings"]({ patch: { defaultRuntimeMode: mode } });
          return previous;
        }).pipe(Effect.scoped),
      );
    // Supervised mode makes the approval recording wait for an answer, which keeps the run queued.
    const previousMode = await setRuntimeMode("approval-required");
    try {
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
        const replied = Promise.withResolvers<string>();
        let forward = () => {};
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          if (typeof data !== "string" || !data.includes('"queued-run.edit"')) {
            return send.call(this, data);
          }
          const request = JSON.parse(data);
          if (
            request.tag !== "orchestration.dispatchCommand" ||
            request.payload?.type !== "queued-run.edit" ||
            !data.includes("Edited queued message")
          ) {
            return send.call(this, data);
          }
          this.addEventListener("message", (event) => {
            const exit = [JSON.parse(String(event.data))]
              .flat()
              .find(
                (frame) => frame._tag === "Exit" && String(frame.requestId) === String(request.id),
              );
            if (exit) replied.resolve(String(exit.exit?._tag));
          });
          forward = () => send.call(this, data);
          requested.resolve();
        };
        window.pendingQueueEdit = {
          requested: requested.promise,
          release: () => {
            forward();
            return replied.promise;
          },
        };
      });

      await t3.open(source);
      const editQueued = screen.getByRole("button", "Edit queued message");
      await expect(editQueued).toBeEnabled({ timeout: 60_000 });
      await editQueued.tap();
      await screen.getByRole("textbox").fill("Edited queued message");
      await screen.getByRole("button", "Update queued message", { exact: false }).tap();
      await browser.evaluate(() => window.pendingQueueEdit.requested.then(() => null));
      await screen.getByRole("button", "Other work", { exact: false }).tap();
      await screen.getByText("Second thread prompt", { exact: true }).tap();
      const focusedComposer = browser.locator(
        '[data-chat-composer-form="true"] [contenteditable="true"]:focus',
      );
      await focusedComposer.waitFor({ state: "hidden" });

      const saved = await browser.evaluate(async () => {
        const exit = await window.pendingQueueEdit.release();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return exit;
      });
      expect(saved).toBe("Success");
      await app.screenshot("other-thread-after-queued-edit-saves");
      await expect(focusedComposer).toBeHidden({ timeout: 3000 });
    } finally {
      await setRuntimeMode(previousMode);
    }
  },
);
