/// <reference lib="dom" />
import { WS_METHODS } from "@t3tools/contracts";
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

interface ReopenGate {
  readonly closed: Promise<void>;
  readonly requested: Promise<void>;
  readonly observeHistory: (modulePath: string) => Promise<void>;
  readonly arm: () => void;
  readonly release: () => Promise<void>;
}

interface ClosedViewHistory {
  readonly entries: readonly { readonly id: string }[];
}

declare global {
  interface Window {
    reopenGate: ReopenGate;
  }
}

test(
  "A browser tab finishing its reopen leaves the newer conversation on screen",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const owner = await t3.thread({ project, title: "Browser owner", messages: ["first"] });
    await t3.thread({
      project,
      title: "Newer conversation",
      messages: ["Stay in this conversation"],
    });

    await browser.addInitScript((previewOpenMethod) => {
      const closed = Promise.withResolvers<void>();
      const requested = Promise.withResolvers<void>();
      const restored = Promise.withResolvers<void>();
      let armed = false;
      let sendHeld = () => {};
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (!armed || typeof data !== "string") return send.call(this, data);
        const parsed = JSON.parse(data);
        const messages = [parsed].flat();
        const isOpen = (message: { _tag?: string; tag?: string }) =>
          message._tag === "Request" && message.tag === previewOpenMethod;
        const previewOpens = messages.filter(isOpen);
        if (previewOpens.length === 0) return send.call(this, data);
        armed = false;
        const others = messages.filter((message) => !isOpen(message));
        if (others.length > 0) send.call(this, JSON.stringify(others));
        sendHeld = () =>
          send.call(this, Array.isArray(parsed) ? JSON.stringify(previewOpens) : data);
        requested.resolve();
      };
      window.reopenGate = {
        closed: closed.promise,
        requested: requested.promise,
        observeHistory: async (modulePath) => {
          const { useClosedViewStore } = (await import(modulePath)) as {
            useClosedViewStore: {
              subscribe: (
                listener: (state: ClosedViewHistory, previous: ClosedViewHistory) => void,
              ) => () => void;
            };
          };
          let closedId: string | undefined;
          const unsubscribe = useClosedViewStore.subscribe(({ entries }, previous) => {
            if (closedId === undefined) {
              closedId = entries.find(
                (entry) => !previous.entries.some((old) => old.id === entry.id),
              )?.id;
              if (closedId !== undefined) closed.resolve();
            } else if (!entries.some((entry) => entry.id === closedId)) {
              unsubscribe();
              restored.resolve();
            }
          });
        },
        arm: () => {
          armed = true;
        },
        release: () => {
          sendHeld();
          return restored.promise;
        },
      };
    }, WS_METHODS.previewOpen);

    await t3.open(owner);
    await screen.getByRole("button", "Toggle right panel").tap();
    await screen.getByRole("button", "Browser B").tap();
    await browser.evaluate(async (modulePath) => {
      await window.reopenGate.observeHistory(modulePath);
      return null;
    }, "/src/closedViewStore.ts");
    await screen.getByRole("button", "Close Browser", { exact: true }).tap();
    await browser.evaluate(async () => {
      await window.reopenGate.closed;
      window.reopenGate.arm();
      return null;
    });

    await browser.keyboard.press("Control+Shift+t");
    await browser.evaluate(async () => {
      await window.reopenGate.requested;
      return null;
    });
    await screen.getByRole("button", "Newer conversation", { exact: false }).tap();
    const newerMessage = screen.getByText("Stay in this conversation", { exact: true });
    await newerMessage.waitFor();
    const newerUrl = await browser.url();
    await browser.evaluate(async () => {
      await window.reopenGate.release();
      return null;
    });

    await app.screenshot("conversation-after-browser-reopens");
    await expect(browser).toHaveURL(newerUrl);
  },
);
