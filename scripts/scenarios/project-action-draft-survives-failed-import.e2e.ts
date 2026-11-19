/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    projectActionImportFailure?: Promise<() => void>;
  }
}

test(
  "A failed project action import preserves a manual action draft",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", {
      "t3.json": JSON.stringify({
        scripts: [{ name: "Shared build", command: "echo build" }],
      }),
    });
    const thread = await t3.thread({ project, title: "Action import", messages: ["Start"] });
    await browser.setViewport({ width: 1920, height: 1000 });

    await browser.addInitScript(() => {
      const pending = Promise.withResolvers<() => void>();
      window.projectActionImportFailure = pending.promise;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request: { _tag: string; id: string; tag: string } | null =
          typeof data === "string" ? JSON.parse(data) : null;
        if (
          typeof data !== "string" ||
          request?._tag !== "Request" ||
          request.tag !== "server.updateSettings" ||
          !data.includes("Shared build")
        ) {
          return send.call(this, data);
        }
        // Delay a settings write failure until the user has started a different action.
        WebSocket.prototype.send = send;
        pending.resolve(() => {
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
                        _tag: "ServerSettingsError",
                        operation: "write-file",
                        settingsPath: "settings.json",
                      },
                    },
                  ],
                },
              }),
            }),
          );
        });
      };
    });

    await t3.open(thread);
    const actions = screen.getByRole("button", "Choose project action", { exact: true });
    await actions.tap();
    await screen.getByRole("menuitem", /Shared build/).tap();
    await browser.evaluate(async () => {
      await window.projectActionImportFailure;
      return null;
    });

    await actions.tap();
    await screen.getByRole("menuitem", "Add project script", { exact: true }).tap();
    const draftName = "My local check";
    await browser.locator("#script-name").fill(draftName);
    await browser.locator("#script-command").fill("echo local");
    await browser.evaluate(async () => {
      const release = await window.projectActionImportFailure!;
      release();
      return null;
    });

    await screen.getByText("Server settings write-file failed at settings.json.").waitFor();
    await app.screenshot("action-draft-after-import-fails");
    const name = await browser.evaluate(
      () => document.querySelector<HTMLInputElement>("#script-name")?.value ?? null,
    );
    expect(name, "The failed import preserves the manual action name").toBe(draftName);
  },
);
