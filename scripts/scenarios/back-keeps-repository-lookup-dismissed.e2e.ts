/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A repository lookup stays dismissed after going Back",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Current work", messages: ["Start"] });

    await t3.open(thread);
    await screen.getByText("Start", { exact: true }).waitFor({ timeout: 30_000 });
    await browser.evaluate(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request = typeof data === "string" ? JSON.parse(data) : null;
        if (request?._tag !== "Request") return send.call(this, data);
        const reply = (value: unknown) =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                _tag: "Exit",
                requestId: request.id,
                exit: { _tag: "Success", value },
              }),
            }),
          );

        if (request.tag === "server.discoverSourceControl") {
          const none = { _tag: "None" };
          queueMicrotask(() =>
            reply({
              versionControlSystems: [],
              sourceControlProviders: [
                {
                  kind: "github",
                  label: "GitHub",
                  status: "available",
                  version: none,
                  installHint: "Install GitHub CLI",
                  detail: none,
                  auth: { status: "authenticated", account: none, host: none, detail: none },
                },
              ],
            }),
          );
          return;
        }

        if (request.tag === "sourceControl.lookupRepository") {
          document.documentElement.dataset.scenarioLookup = "pending";
          document.addEventListener(
            "release-repository-lookup",
            () =>
              reply({
                provider: "github",
                nameWithOwner: "example/slow",
                url: "https://github.com/example/slow",
                sshUrl: "git@github.com:example/slow.git",
              }),
            { once: true },
          );
          return;
        }
        return send.call(this, data);
      };
      return null;
    });

    await browser.keyboard.press("Control+k");
    const palette = screen.getByRole("dialog", "Command palette");
    await palette.getByRole("combobox").fill("> Add project");
    await palette.getByText("Add project", { exact: true }).tap();
    await palette.getByRole("option", /^GitHub repository/).tap();
    await palette.getByRole("combobox").fill("example/slow");
    await screen.getByRole("button", "Lookup (Enter)").tap();
    await browser.locator("html[data-scenario-lookup=pending]").waitFor();
    await palette.getByRole("combobox").fill("");
    await browser.keyboard.press("Backspace");
    const sources = screen.getByText("Git URL", { exact: true });
    await sources.waitFor();

    await browser.evaluate(async () => {
      document.dispatchEvent(new Event("release-repository-lookup"));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return null;
    });
    await app.screenshot("after-dismissed-lookup-returns");
    await expect(sources).toBeVisible();
  },
);
