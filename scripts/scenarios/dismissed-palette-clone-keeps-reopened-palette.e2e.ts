/// <reference lib="dom" />
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture serves a local Git remote.
import * as NodeHttp from "node:http";
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A clone reply leaves a newly opened command palette open",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Current work", messages: ["Start"] });
    const remote = NodeHttp.createServer();
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    try {
      const address = remote.address();
      if (!address || typeof address === "string") throw new Error("No Git fixture port");

      await browser.addInitScript(() => {
        const starts = new WeakMap<WebSocket, string>();
        let released = false;
        const searchesAfterRelease = new Set<string>();
        document.addEventListener("release-palette-clone-start", () => {
          released = true;
        });
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          if (typeof data === "string") {
            for (const request of [JSON.parse(data)].flat()) {
              if (request?._tag === "Request" && request.tag === "projectClone.start") {
                starts.set(this, String(request.id));
              }
              if (
                released &&
                request?._tag === "Request" &&
                request.tag === "orchestration.searchThreads"
              ) {
                searchesAfterRelease.add(String(request.id));
              }
            }
          }
          return send.call(this, data);
        };
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
          return listen.call(
            this,
            type,
            (event: Event) => {
              const { data } = event as MessageEvent;
              const wire = typeof data === "string" ? [JSON.parse(data)].flat() : [];
              if (
                wire.some(
                  (message) =>
                    message?._tag === "Exit" &&
                    message.exit?._tag === "Success" &&
                    String(message.requestId) === starts.get(this),
                )
              ) {
                document.documentElement.dataset.scenarioCloneReply = "ready";
                document.addEventListener(
                  "release-palette-clone-start",
                  () => listener.call(this, event),
                  {
                    once: true,
                  },
                );
              } else {
                listener.call(this, event);
                if (
                  wire.some(
                    (message) =>
                      message?._tag === "Exit" &&
                      searchesAfterRelease.has(String(message.requestId)),
                  )
                ) {
                  document.documentElement.dataset.scenarioSearchAfterRelease = "answered";
                }
              }
            },
            options,
          );
        } as typeof WebSocket.prototype.addEventListener;
      });

      await t3.open(thread);
      await screen.getByText("Start", { exact: true }).waitFor({ timeout: 30_000 });
      const palette = screen.getByRole("dialog", "Command palette");
      await browser.keyboard.press("Control+k");
      await palette.getByRole("combobox").fill("> Add project");
      await palette.getByText("Add project", { exact: true }).tap();
      await palette.getByRole("option", /^Git URL/).tap();
      await palette.getByRole("combobox").fill(`http://127.0.0.1:${address.port}/clone.git`);
      await screen.getByRole("button", "Continue (Enter)").tap();
      await palette.getByRole("combobox").fill(`${project}-copy`);
      await palette.getByRole("button", /^(?:Create & )?Clone \(/).tap();
      await browser.locator("html[data-scenario-clone-reply=ready]").waitFor();
      await browser.keyboard.press("Escape");
      await palette.waitFor({ state: "hidden" });
      await browser.keyboard.press("Control+k");
      await palette.getByRole("combobox").fill("Current work");
      await browser.evaluate(() => {
        document.dispatchEvent(new Event("release-palette-clone-start"));
        return null;
      });
      // A search sent after the release is answered only after the clone reply's
      // continuation ran; if that continuation closed the palette, no search is sent.
      await browser.keyboard.press("Backspace");
      const openPalette = '[data-slot="command-dialog-popup"][data-open]';
      await browser
        .locator(
          `html[data-scenario-search-after-release=answered], html:not(:has(${openPalette}))`,
        )
        .waitFor({ state: "attached" });
      await app.screenshot("reopened-palette-after-clone-start-returns");
      expect(await browser.locator(openPalette).isVisible()).toBe(true);
    } finally {
      remote.close();
      remote.closeAllConnections();
    }
  },
);
