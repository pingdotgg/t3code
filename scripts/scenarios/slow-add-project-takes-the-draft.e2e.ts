/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A slow project update still moves the current draft into the added project",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const workspace = await t3.project("demo", { "next/README.md": "" });
    await browser.addInitScript(() => {
      const NativeWebSocket = WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        private createRequestId: string | null = null;
        private shellRequestId: string | null = null;
        private held: string[] = [];

        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          // Register before the app starts reading this socket.
          this.addEventListener("message", (event) => {
            if (this.createRequestId === null || typeof event.data !== "string") return;
            const frames = [JSON.parse(event.data)].flat();
            if (
              frames.some(
                (frame) => frame._tag === "Exit" && frame.requestId === this.createRequestId,
              )
            ) {
              // Deliver the project creation reply before resuming the project list stream.
              // @effect-diagnostics-next-line globalTimers:off - This callback is injected into the browser.
              setTimeout(() => {
                this.createRequestId = null;
                for (const data of this.held.splice(0)) {
                  this.dispatchEvent(new MessageEvent("message", { data }));
                }
              }, 4500);
              return;
            }
            if (
              frames.some(
                (frame) => frame._tag === "Chunk" && frame.requestId === this.shellRequestId,
              )
            ) {
              event.stopImmediatePropagation();
              this.held.push(event.data);
              document.documentElement.dataset.delayedProjectUpdate = "true";
            }
          });
        }

        override send(data: Parameters<WebSocket["send"]>[0]) {
          if (typeof data === "string") {
            for (const request of [JSON.parse(data)].flat()) {
              if (request.tag === "orchestration.subscribeShell") {
                this.shellRequestId = request.id;
              }
              if (
                request.tag === "projects.mutate" &&
                request.payload?.type === "project.create" &&
                request.payload?.title === "next"
              ) {
                this.createRequestId = request.id;
              }
            }
          }
          super.send(data);
        }
      };
    });
    await t3.open();

    const composer = screen.getByRole("textbox");
    await composer.fill("Plan the next project");
    const projectPicker = browser.locator("[data-draft-project-trigger]");
    await projectPicker.tap();
    await screen.getByRole("option", "Add project").tap();
    await screen.getByText("Local folder").tap();
    await screen.getByRole("combobox").fill(`${workspace}/next`);
    await browser.keyboard.press("Enter");

    await browser
      .locator('html[data-delayed-project-update="true"]')
      .waitFor({ state: "attached" });
    await projectPicker.filter({ hasText: "next" }).waitFor();
    await app.screenshot("after-add");
    await expect(composer).toContainText("Plan the next project");
  },
);
