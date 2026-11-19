/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    releaseFirstRepeatedActionImport?: Promise<() => void>;
  }
}

test(
  "Importing the same project action twice while a save is pending saves one copy",
  WEB,
  async ({ t3, browser, screen }) => {
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
      window.releaseFirstRepeatedActionImport = first.promise;
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
        // Keep the first settings write pending across both selections of Shared build.
        WebSocket.prototype.send = send;
        first.resolve(() => send.call(this, data));
      };
    });

    await t3.open(thread);
    const imports = screen.getByRole("button", "Choose project action", { exact: true });
    await imports.tap();
    await screen.getByRole("menuitem", /Shared build/).tap();
    await browser.evaluate(async () => {
      await window.releaseFirstRepeatedActionImport;
      return null;
    });
    await imports.tap();
    await screen.getByRole("menuitem", /Shared build/).tap();
    // A distinct import gives the test an observable milestone after the repeated selection.
    await imports.tap();
    await screen.getByRole("menuitem", /Shared checks/).tap();
    await browser.evaluate(async () => {
      const release = await window.releaseFirstRepeatedActionImport!;
      release();
      return null;
    });

    const actions = screen.getByRole("button", "Script actions", { exact: true });
    await actions.tap();
    await screen.getByRole("button", "Edit Shared checks", { exact: true }).waitFor();
    const importedCopies = await browser.evaluate(
      () => document.querySelectorAll('button[aria-label="Edit Shared build"]').length,
    );
    expect(importedCopies, "The repeated selection saves just one copy of Shared build").toBe(1);
  },
);
