/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Retrying a project action save after a shortcut error creates one action",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Project work", messages: ["Start"] });
    await browser.setViewport({ width: 1920, height: 1000 });
    await browser.addInitScript(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (this: WebSocket, data) {
        if (typeof data !== "string") return send.call(this, data);
        const request: { _tag?: string; tag?: string; id?: string } = JSON.parse(data);
        if (request._tag !== "Request" || request.tag !== "server.upsertKeybinding") {
          return send.call(this, data);
        }
        // Fail one shortcut write at the RPC boundary while the action settings still use the real server.
        WebSocket.prototype.send = send;
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                _tag: "Exit",
                requestId: request.id,
                exit: {
                  _tag: "Failure",
                  cause: [
                    {
                      _tag: "Fail",
                      error: {
                        _tag: "KeybindingsConfigParseError",
                        configPath: "keybindings.json",
                        detail: "Temporary write failure",
                      },
                    },
                  ],
                },
              }),
            }),
          ),
        );
      };
    });

    await t3.open(thread);
    await screen.getByRole("button", "Add project script", { exact: true }).tap();
    await browser.locator("#script-name").fill("Run smoke checks");
    await browser.locator("#script-command").fill("echo checks");
    await browser.locator("#script-keybinding").press("Control+Shift+7");
    const editor = browser.locator('[data-slot="dialog-popup"][data-open]');
    const save = editor.getByRole("button", "Save action", { exact: true });
    await save.tap();
    await editor.getByRole("button", "Saving…", { exact: true }).waitFor({ state: "hidden" });
    if (await save.isVisible()) {
      await save.tap();
      await editor.waitFor({ state: "hidden" });
    }

    await screen.getByRole("button", "Script actions", { exact: true }).tap();
    const entries = screen.getByRole("menuitem", /^Run smoke checks/);
    await entries.first().waitFor();
    await app.screenshot("actions-after-retrying-save");
    expect(await entries.count()).toBe(1);
  },
);
