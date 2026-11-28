/// <reference lib="dom" />
import { expect } from "e2e";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

test(
  "A late branch checkout leaves the draft in the project chosen while it was pending",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const settings = { "t3.json": JSON.stringify({ defaultThreadEnvMode: "local" }) };
    const project = await t3.project("demo", settings);
    await t3.project("other-project", settings);
    await runPromise(run("git", ["branch", "feature"], { cwd: project }));
    await browser.addInitScript(() => {
      const starts = new WeakMap<WebSocket, string>();
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          for (const request of [JSON.parse(data)].flat()) {
            if (request?._tag === "Request" && request.tag === "vcs.switchRef") {
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
              document.documentElement.dataset.scenarioBranchReply = "ready";
              document.addEventListener(
                "release-branch-checkout",
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

    await t3.open("/");
    const projectPicker = browser.locator("[data-draft-project-trigger]");
    await projectPicker.waitFor();
    if ((await projectPicker.textContent())?.trim() !== "demo") {
      await projectPicker.tap();
      await screen.getByRole("option", "demo", { exact: true }).tap();
    }
    await screen.getByRole("textbox").fill("Plan the next change");
    const draftPath = await browser.evaluate(() => location.pathname);
    const branchPicker = browser
      .locator('[data-slot="combobox-trigger"][aria-label^="Branch:"]:visible')
      .first();
    await branchPicker.click();
    await screen.getByRole("option", /^feature\b/).tap();
    await browser.locator("html[data-scenario-branch-reply=ready]").waitFor();

    await projectPicker.tap();
    await screen.getByRole("option", "other-project", { exact: true }).tap();
    await projectPicker.filter({ hasText: "other-project" }).waitFor();
    if ((await browser.evaluate(() => location.pathname)) !== draftPath) {
      throw new Error("The project picker opened a different draft.");
    }
    await expect(branchPicker).toBeDisabled();
    await browser.evaluate(() => {
      document.dispatchEvent(new Event("release-branch-checkout"));
      return null;
    });
    await expect(branchPicker).toBeEnabled();
    await app.screenshot("draft-after-old-branch-checkout");
    expect((await projectPicker.textContent())?.trim()).toBe("other-project");
  },
);
