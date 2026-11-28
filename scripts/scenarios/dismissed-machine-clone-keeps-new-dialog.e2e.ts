/// <reference lib="dom" />
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture holds Git's HTTP request open.
import * as NodeHttp from "node:http";
import { expect } from "e2e";

import { startSecondServer } from "./second-server.ts";
import { test, WEB } from "./t3.ts";

test(
  "A dismissed clone start leaves the next Add to another machine dialog open",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const remote = NodeHttp.createServer();
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const second = startSecondServer(app.baseUrl ?? "");
    try {
      const address = remote.address();
      if (!address || typeof address === "string") throw new Error("No Git fixture port");
      const seedProject = (name: string) =>
        t3.project(name, {
          ".git/config": `[remote "origin"]\nurl = http://127.0.0.1:${address.port}/scenario/${name}.git\n`,
        });
      const first = await seedProject("first-repository");
      await seedProject("second-repository");

      // Deliver the real reply after the second dialog is open.
      await browser.addInitScript(() => {
        const startRequests = new WeakMap<WebSocket, string>();
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          const request =
            typeof data === "string" && data.includes("projectClone.start")
              ? JSON.parse(data)
              : null;
          if (request?._tag === "Request" && request.tag === "projectClone.start") {
            startRequests.set(this, String(request.id));
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
                    String(message.requestId) === startRequests.get(this),
                )
              ) {
                document.documentElement.dataset.scenarioCloneReply = "ready";
                document.addEventListener(
                  "release-machine-clone-start",
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

      const { host, token } = await second.ready;
      await browser.setViewport({ width: 1920, height: 1000 });
      await t3.open("/settings/connections");
      await screen.getByRole("button", "Add environment").tap();
      const pairing = screen.getByRole("dialog");
      await pairing.getByPlaceholder("backend.example.com").fill(host);
      await pairing.getByPlaceholder("PAIRCODE").fill(token);
      await pairing.getByRole("button", "Add environment").tap();
      await screen.getByRole("button", "List", { exact: true }).tap();
      await screen.getByRole("button", "More actions for Scenario").waitFor();

      await app.open("/");
      const projectPicker = browser.locator("[data-draft-project-trigger]");
      const dialog = screen.getByRole("dialog", "Add to another machine");
      const openFor = async (name: string) => {
        await projectPicker.tap();
        await screen.getByRole("option", name, { exact: true }).tap();
        await projectPicker.getByText(name, { exact: true }).waitFor();
        await screen.getByRole("combobox", "Run on", { exact: true }).tap();
        await screen.getByRole("option", "Add to another machine", { exact: true }).tap();
        await dialog
          .getByText(`Clone scenario/${name} and bring the local files git does not track.`, {
            exact: true,
          })
          .waitFor();
      };
      await openFor("first-repository");
      await dialog.getByRole("textbox", /^Folder on/).fill(`${first}/../first-copy`);
      await dialog.getByRole("button", /^Clone to/).tap();
      await dialog.getByRole("button", "Starting…").waitFor();
      await dialog.getByRole("button", "Cancel", { exact: true }).tap();
      await openFor("second-repository");

      await browser.locator("html[data-scenario-clone-reply=ready]").waitFor();
      await browser.evaluate(async () => {
        document.dispatchEvent(new Event("release-machine-clone-start"));
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return null;
      });
      await app.screenshot("dialog-after-dismissed-clone-start-returns");
      await expect(dialog).toBeVisible();
    } finally {
      remote.close();
      remote.closeAllConnections();
      await second.stop();
    }
  },
);
