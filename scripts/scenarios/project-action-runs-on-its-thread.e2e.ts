/// <reference lib="dom" />
// The DOM lib types the functions this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { runPromise, test, WEB } from "./t3.ts";

const exists = (path: string) =>
  runPromise(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path)));

test(
  "A project action runs on its thread after switching threads while its terminal opens",
  WEB,
  async ({ t3, app, browser, screen }) => {
    // Holds terminal.open requests while the page sets holdTerminalOpen, until it calls
    // releaseTerminalOpen, so the switch lands before the terminal is ready.
    await browser.addInitScript(() => {
      const held: Array<() => void> = [];
      const page = window as unknown as Record<string, unknown>;
      page.holdTerminalOpen = false;
      page.heldTerminalOpens = () => held.length;
      page.releaseTerminalOpen = () => {
        page.holdTerminalOpen = false;
        for (const send of held.splice(0)) send();
      };
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const opensTerminal =
          typeof data === "string" &&
          [JSON.parse(data)]
            .flat()
            .some((message) => message?._tag === "Request" && message.tag === "terminal.open");
        if (opensTerminal && page.holdTerminalOpen === true) {
          held.push(() => send.call(this, data));
          return;
        }
        return send.call(this, data);
      };
    });

    const project = await t3.project("demo", {
      "t3.json": JSON.stringify({ scripts: [{ name: "Mark", command: "touch action-ran" }] }),
    });
    await t3.thread({ project, title: "Other thread", messages: ["first"] });
    const thread = await t3.thread({ project, title: "Action thread", messages: ["first"] });
    await t3.open(thread);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();

    await screen.getByRole("button", "Project actions").tap();
    await screen.getByRole("menuitem", "Mark Import").tap();
    const run = screen.getByRole("button", "Run Mark");
    await expect(run).toBeVisible();

    await browser.evaluate(() => {
      (window as unknown as Record<string, unknown>).holdTerminalOpen = true;
      return null;
    });
    await run.tap();
    await expect
      .poll(() =>
        browser.evaluate(() =>
          (window as unknown as { heldTerminalOpens: () => number }).heldTerminalOpens(),
        ),
      )
      .toBeGreaterThan(0);

    await screen.getByRole("button", /^Other thread,/).tap();
    await expect(browser).not.toHaveURL(new RegExp(thread.threadId));
    await browser.evaluate(() => {
      (window as unknown as { releaseTerminalOpen: () => void }).releaseTerminalOpen();
      return null;
    });

    await screen.getByRole("button", /^Action thread,/).tap();
    await app.screenshot("back-on-action-thread");
    await expect.poll(() => exists(`${project}/action-ran`)).toBe(true);
  },
);
