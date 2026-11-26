/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { runPromise, test, WEB } from "./t3.ts";

const PROBE = String.raw`import { existsSync, writeFileSync } from "node:fs";
const file = (name) => new URL(name, import.meta.url);
const ask = () => process.stdout.write("\x1b[6n");
let buffer = "";
let secondQuery = false;
process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  if (buffer.includes("s")) writeFileSync(file("second-ready"), "ready");
  if (!/\x1b\[\d+;\d+R/.test(buffer)) return;
  buffer = buffer.replace(/\x1b\[\d+;\d+R/, "");
  if (secondQuery) {
    writeFileSync(file("answer"), "reply received");
    process.stdout.write("\r\nReply received\r\n");
  } else {
    writeFileSync(file("first-ready"), "ready");
  }
});
ask();
const timer = setInterval(() => {
  if (!existsSync(file("ask-again"))) return;
  clearInterval(timer);
  secondQuery = true;
  process.stdout.write("\r\nWaiting for cursor position...\r\n");
  ask();
}, 50);
`;

test(
  "A second viewer answers terminal queries after the first viewer closes during a pending write",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await browser.emulateMedia({ colorScheme: "dark" });
    const project = await t3.project("demo", { "cursor-probe.mjs": PROBE });
    const thread = await t3.thread({ project, title: "Shared terminal", messages: ["hello"] });
    const read = (name: string) =>
      runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.readFileString(`${project}/${name}`);
        }).pipe(Effect.orElseSucceed(() => "")),
      );

    // Delay one ordinary keystroke on the first connection to model a write in flight.
    await browser.addInitScript(() => {
      if (window !== window.top) return;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (
          document.body?.dataset.holdTerminalWrite === "true" &&
          typeof data === "string" &&
          data.includes('"data":"x"')
        ) {
          document.body.dataset.terminalWritePending = "true";
          const socket = this;
          window.addEventListener("release-terminal-write", () => send.call(socket, data), {
            once: true,
          });
          return;
        }
        return send.call(this, data);
      };
    });

    await t3.open(thread);
    const toggle = screen.getByRole("button", "Toggle terminal drawer");
    const first = screen.getByLabel("Terminal input");
    await browser.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "second-viewer";
      frame.src = location.pathname;
      frame.style.cssText =
        "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647";
      document.body.append(frame);
      return null;
    });
    const second = browser.frameLocator("#second-viewer");
    const secondInput = second.getByLabel("Terminal input");
    const secondToggle = second.getByRole("button", "Toggle terminal drawer");
    await secondToggle.waitFor();
    const showSecond = (show: boolean) =>
      browser.evaluate((visible) => {
        document.querySelector<HTMLIFrameElement>("#second-viewer")!.style.display = visible
          ? ""
          : "none";
        return null;
      }, show);
    await showSecond(false);
    await toggle.tap();
    await expect
      .poll(
        async () => {
          await first.focus();
          await browser.keyboard.type(`echo ready > '${project}/shell-ready'`);
          await browser.keyboard.press("Enter");
          return read("shell-ready");
        },
        { timeout: 20_000 },
      )
      .toBe("ready\n");
    await browser.keyboard.type(`'${process.execPath}' '${project}/cursor-probe.mjs'`);
    await browser.keyboard.press("Enter");
    await expect.poll(() => read("first-ready")).toBe("ready");

    await showSecond(true);
    await secondToggle.tap();
    await secondInput.waitFor();
    await expect
      .poll(async () => {
        await secondInput.focus();
        await browser.keyboard.type("s");
        return read("second-ready");
      })
      .toBe("ready");

    await showSecond(false);
    await first.focus();
    await browser.evaluate(() => {
      document.body.dataset.holdTerminalWrite = "true";
      return null;
    });
    await browser.keyboard.type("x");
    await expect
      .poll(() => browser.evaluate(() => document.body.dataset.terminalWritePending ?? ""))
      .toBe("true");

    try {
      await toggle.tap();
      await first.waitFor({ state: "hidden" });
      await showSecond(true);
      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(`${project}/ask-again`, "");
        }),
      );
      try {
        await expect.poll(() => read("answer")).toBe("reply received");
      } finally {
        await app.screenshot("query-after-first-viewer-closes");
      }
    } finally {
      await browser.evaluate(() => {
        window.dispatchEvent(new Event("release-terminal-write"));
        return null;
      });
    }
  },
);
