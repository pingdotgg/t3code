/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    releaseFirstActionImport?: Promise<() => void>;
  }
}

test(
  "Importing a second project action while the first saves keeps both actions",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", {
      "t3.json": JSON.stringify({
        scripts: [
          { name: "Shared build", command: "echo build" },
          { name: "Shared checks", command: "echo check" },
        ],
      }),
    });
    const thread = await t3.thread({ project, title: "Action imports", messages: ["Start"] });
    await browser.setViewport({ width: 1920, height: 1000 });
    await browser.addInitScript(() => {
      const first = Promise.withResolvers<() => void>();
      window.releaseFirstActionImport = first.promise;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request: { _tag: string; tag: string } | null =
          typeof data === "string" ? JSON.parse(data) : null;
        if (
          typeof data !== "string" ||
          request?._tag !== "Request" ||
          request.tag !== "server.updateSettings" ||
          !data.includes("Shared build")
        ) {
          return send.call(this, data);
        }
        // Keep the first real settings write pending until after the second import is selected.
        WebSocket.prototype.send = send;
        first.resolve(() => send.call(this, data));
      };
    });

    await t3.open(thread);
    const imports = screen.getByRole("button", "Choose project action", { exact: true });
    await imports.tap();
    await screen.getByRole("menuitem", /Shared build/).tap();
    await browser.evaluate(async () => {
      await window.releaseFirstActionImport;
      return null;
    });
    await imports.tap();
    await screen.getByRole("menuitem", /Shared checks/).tap();
    await browser.evaluate(async () => {
      const release = await window.releaseFirstActionImport!;
      release();
      return null;
    });

    const actions = screen.getByRole("button", "Script actions", { exact: true });
    await actions.tap();
    // The edit buttons are only present for imported actions, even if both names are listed.
    await screen.getByRole("button", "Edit Shared checks", { exact: true }).waitFor();
    await app.screenshot("after-importing-both-project-actions");
    const firstAction = screen.getByRole("button", "Edit Shared build", { exact: true });
    expect(
      await firstAction.isVisible(),
      "The first action is still imported after the second action saves",
    ).toBe(true);
  },
);
