/// <reference lib="dom" />
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture serves a local Git remote.
import * as NodeHttp from "node:http";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { test, WEB } from "./t3.ts";

test(
  "Reopening the palette while a cloned project syncs leaves the draft in place",
  WEB,
  async ({ t3, browser, screen }) => {
    const project = await t3.project("demo");
    const name = "cloned-draft-project";
    const remote = NodeHttp.createServer();
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    try {
      const address = remote.address();
      if (!address || typeof address === "string") throw new Error("No Git fixture port");
      await browser.addInitScript((title) => {
        const listen = WebSocket.prototype.addEventListener;
        WebSocket.prototype.addEventListener = function (
          this: WebSocket,
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) {
          if (type !== "message" || typeof listener !== "function") {
            return listen.call(this, type, listener, options);
          }
          let released = false;
          let heldRequestId: string | undefined;
          document.addEventListener("release-cloned-project", () => {
            released = true;
          });
          return listen.call(
            this,
            type,
            (event: Event) => {
              const { data } = event as MessageEvent;
              const messages = typeof data === "string" ? [JSON.parse(data)].flat() : [];
              const held = messages.find(
                (message) =>
                  message?._tag === "Chunk" &&
                  (message.requestId === heldRequestId ||
                    message.values.some(
                      (value: unknown) =>
                        typeof value === "object" &&
                        value !== null &&
                        "kind" in value &&
                        value.kind === "project.updated" &&
                        "project" in value &&
                        typeof value.project === "object" &&
                        value.project !== null &&
                        "title" in value.project &&
                        value.project.title === title,
                    )),
              );
              if (!released && held) {
                heldRequestId = held.requestId;
                document.documentElement.dataset.clonedProject = "held";
                document.addEventListener(
                  "release-cloned-project",
                  () => listener.call(this, event),
                  {
                    once: true,
                  },
                );
                return;
              }
              listener.call(this, event);
            },
            options,
          );
        } as typeof WebSocket.prototype.addEventListener;
      }, name);

      await t3.open();
      await screen.getByRole("textbox").fill("Keep this draft here");
      const projectPicker = browser.locator("[data-draft-project-trigger]");
      const originalProject = await browser.evaluate(
        () => document.querySelector("[data-draft-project-trigger]")?.textContent?.trim() ?? "",
      );
      await projectPicker.tap();
      await screen.getByRole("option", "Add project").tap();
      const palette = screen.getByRole("dialog", "Command palette");
      await palette.getByRole("option", /^Git URL/).tap();
      await palette.getByRole("combobox").fill(`http://127.0.0.1:${address.port}/clone.git`);
      await screen.getByRole("button", "Continue (Enter)").tap();
      await palette.getByRole("combobox").fill(`${project}/${name}`);
      await palette.getByRole("button", /^(?:Create & )?Clone \(/).tap();
      await browser.locator("html[data-cloned-project=held]").waitFor();
      await palette.waitFor({ state: "hidden" });
      // Let the first project wait expire so a second wait would still be pending.
      await Effect.runPromise(Effect.sleep("3100 millis"));
      await browser.keyboard.press("Control+k");
      await palette.getByRole("combobox").fill("Keep this draft");
      await browser.evaluate(async () => {
        document.dispatchEvent(new Event("release-cloned-project"));
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return null;
      });
      await expect(projectPicker).toHaveText(originalProject);
      await expect(palette.getByRole("combobox")).toBeVisible();
    } finally {
      remote.close();
      remote.closeAllConnections();
    }
  },
);
