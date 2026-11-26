/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A connected Android phone is not listed as an emulator",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Android phone", messages: ["Start"] });

    // Supply the inventory returned by a ready Android host with only Platform-Tools.
    await browser.addInitScript(() => {
      const subscriptions = new WeakMap<WebSocket, string>();
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          for (const message of [JSON.parse(data)].flat()) {
            if (message?._tag === "Request" && message.tag === "subscribeDeviceState") {
              subscriptions.set(this, String(message.id));
            }
          }
        }
        return send.call(this, data);
      };
      const addEventListener = WebSocket.prototype.addEventListener;
      WebSocket.prototype.addEventListener = function (
        this: WebSocket,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type !== "message" || typeof listener !== "function") {
          return addEventListener.call(this, type, listener, options);
        }
        return addEventListener.call(
          this,
          type,
          (event: Event) => {
            const data = (event as MessageEvent).data;
            if (typeof data !== "string") return listener.call(this, event);
            const parsed = JSON.parse(data);
            let changed = false;
            for (const message of [parsed].flat()) {
              if (
                message?._tag !== "Chunk" ||
                String(message.requestId) !== subscriptions.get(this)
              )
                continue;
              for (const state of message.values) {
                Object.assign(state, {
                  hostStatus: "ready",
                  hostStatuses: { local: { status: "ready" } },
                  hosts: [
                    {
                      id: "local",
                      label: "This machine",
                      kind: "local",
                      platforms: [{ platform: "android", available: true }],
                      hubInstalled: true,
                      agentDeviceInstalled: true,
                    },
                  ],
                  devices: [
                    {
                      hostId: "local",
                      id: "R52T10ABCDE",
                      name: "Samsung SM-X710",
                      platform: "android",
                      version: "Android 15",
                      booted: true,
                      physical: true,
                    },
                  ],
                  onboardingCompleted: true,
                });
                changed = true;
              }
            }
            listener.call(
              this,
              changed ? new MessageEvent("message", { data: JSON.stringify(parsed) }) : event,
            );
          },
          options,
        );
      } as typeof WebSocket.prototype.addEventListener;
    });

    await t3.open(thread);
    await screen.getByRole("button", "Toggle right panel").tap();
    await screen.getByText("Device", { exact: true }).tap();
    await screen.getByText("Samsung SM-X710", { exact: true }).waitFor();
    await app.screenshot("connected-android-phone");

    const heading = await browser.evaluate(
      () =>
        document
          .querySelector('[aria-label="Open Samsung SM-X710"]')
          ?.closest("section")
          ?.querySelector("h3")?.textContent ?? "",
    );
    expect(heading).not.toMatch(/emulator/i);
  },
);
