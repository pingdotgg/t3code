/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A project creation reply leaves a newly opened command palette open",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Current work", messages: ["Start"] });
    await browser.addInitScript(() => {
      const starts = new WeakMap<WebSocket, string>();
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          for (const request of [JSON.parse(data)].flat()) {
            if (request?._tag === "Request" && request.tag === "projects.createNew") {
              starts.set(this, String(request.id));
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
              document.documentElement.dataset.scenarioCreateReply = "ready";
              document.addEventListener(
                "release-palette-create-project",
                () => listener.call(this, event),
                {
                  once: true,
                },
              );
            } else {
              listener.call(this, event);
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
    await palette.getByRole("combobox").fill("> New project");
    await palette.getByText("New project", { exact: true }).tap();
    await palette.getByRole("combobox").fill("new-scenario-project");
    await palette.getByRole("button", /^Create \(/).tap();
    await browser.locator("html[data-scenario-create-reply=ready]").waitFor();
    await browser.keyboard.press("Escape");
    await palette.waitFor({ state: "hidden" });
    await browser.keyboard.press("Control+k");
    await palette.getByRole("combobox").fill("Current work");
    await browser.evaluate(async () => {
      document.dispatchEvent(new Event("release-palette-create-project"));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return null;
    });
    await app.screenshot("reopened-palette-after-project-creation-returns");
    const openPalette = browser.locator('[data-slot="command-dialog-popup"][data-open]');
    expect(await openPalette.isVisible()).toBe(true);
  },
);
