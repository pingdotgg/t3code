/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Adding a folder does not take over the thread opened while it was pending",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", { "next/README.md": "" });
    const thread = await t3.thread({ project, title: "Current work", messages: ["Start"] });
    const other = await t3.thread({
      project,
      title: "Other work",
      messages: ["Keep this thread open"],
    });
    await browser.addInitScript(() => {
      const starts = new WeakMap<WebSocket, string>();
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          for (const request of [JSON.parse(data)].flat()) {
            if (
              request?._tag === "Request" &&
              request.tag === "projects.mutate" &&
              request.payload.type === "project.create"
            ) {
              starts.set(this, String(request.id));
              document.documentElement.dataset.scenarioCreateProjectId = request.payload.projectId;
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
    await palette.getByRole("combobox").fill("> Add project");
    await palette.getByText("Add project", { exact: true }).tap();
    await palette.getByText("Local folder", { exact: true }).tap();
    await palette.getByRole("combobox").fill(`${project}/next`);
    await browser.keyboard.press("Enter");
    const reply = browser.locator("html[data-scenario-create-reply=ready]");
    await reply.waitFor();
    t3.trackProject?.((await reply.getAttribute("data-scenario-create-project-id"))!);
    await browser.keyboard.press("Escape");
    await palette.waitFor({ state: "hidden" });
    await browser.keyboard.press("Control+k");
    await palette.getByRole("combobox").fill("Other work");
    await palette.getByText("Other work", { exact: true }).tap();
    await screen.getByText("Keep this thread open", { exact: true }).waitFor();
    await browser.evaluate(async () => {
      document.dispatchEvent(new Event("release-palette-create-project"));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return null;
    });
    await app.screenshot("thread-after-folder-add-reply");
    const openThread = await browser.evaluate(() =>
      decodeURIComponent(location.pathname.split("/").at(-1) ?? ""),
    );
    expect(openThread === other.threadId).toBe(true);
  },
);
