/// <reference lib="dom" />
import { expect } from "e2e";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

test(
  "A late branch checkout leaves the draft in the workspace chosen while it was pending",
  WEB,
  async ({ t3, browser, screen }) => {
    const settings = { "t3.json": JSON.stringify({ defaultThreadEnvMode: "local" }) };
    const project = await t3.project("demo", settings);
    await t3.project("other-project", settings);
    const cases = [
      { branch: "return", projects: ["other-project", "demo"] },
      { branch: "workspace", projects: [] },
    ];
    for (const { branch } of cases) {
      await runPromise(run("git", ["branch", branch], { cwd: project }));
    }
    await browser.addInitScript(() => {
      const starts = new WeakMap<WebSocket, string>();
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          for (const request of [JSON.parse(data)].flat()) {
            if (request?._tag === "Request" && request.tag === "vcs.switchRef") {
              delete document.documentElement.dataset.scenarioBranchReply;
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
    const branchPicker = browser
      .locator('[data-slot="combobox-trigger"][aria-label^="Branch:"]:visible')
      .first();
    const workspace = browser
      .locator('[data-composer-shortcut~="composer.workspace"]:visible')
      .first();
    const moveDraft = async (project: string) => {
      await projectPicker.tap();
      await screen.getByRole("option", project, { exact: true }).tap();
      await projectPicker.filter({ hasText: project }).waitFor();
    };
    if ((await projectPicker.textContent())?.trim() !== "demo") await moveDraft("demo");
    await screen.getByRole("textbox").fill("Plan the next change");
    const draftPath = await browser.evaluate(() => location.pathname);

    for (const { branch, projects } of cases) {
      await branchPicker.click();
      await screen.getByRole("option", new RegExp(`^${branch}\\b`)).tap();
      await browser.locator("html[data-scenario-branch-reply=ready]").waitFor();

      for (const project of projects) await moveDraft(project);
      await workspace.tap();
      await screen.getByRole("option", "New worktree", { exact: true }).tap();
      await expect(workspace).toContainText("New worktree");
      if ((await browser.evaluate(() => location.pathname)) !== draftPath) {
        throw new Error("The project picker opened a different draft.");
      }
      await expect(branchPicker).toBeDisabled();
      await browser.evaluate(() => {
        document.dispatchEvent(new Event("release-branch-checkout"));
        return null;
      });
      await expect(branchPicker).toBeEnabled();
      await expect(workspace).toContainText("New worktree");

      if (branch === "return") {
        await workspace.tap();
        await screen.getByRole("option", "Current checkout", { exact: true }).tap();
      }
    }
  },
);
