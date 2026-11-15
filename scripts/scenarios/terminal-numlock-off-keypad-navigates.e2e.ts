/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { runPromise, test, WEB } from "./t3.ts";

// A raw-mode program turns on application cursor and keypad modes as ncurses keypad(TRUE) does,
// asks for DECCKM so its reply marks when the terminal has applied them, and logs what it reads.
const PROBE = String.raw`import { appendFileSync, writeFileSync } from "node:fs";

const log = new URL("received", import.meta.url);
writeFileSync(log, "");
process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  appendFileSync(log, chunk);
  if (chunk.includes("x")) {
    process.stdout.write("\x1b[?1l\x1b>");
    process.stdin.setRawMode(false);
    process.exit(0);
  }
});
process.stdout.write("\x1b[?1h\x1b=\x1b[?1$p");
`;

const READY = "\x1b[?1;1$y";
// Keypad keys as a browser reports them with NumLock off: the physical digit, the navigation key.
const KEYPAD = [
  { code: "Numpad8", key: "ArrowUp" },
  { code: "Numpad1", key: "End" },
  { code: "NumpadDecimal", key: "Delete" },
];

test(
  "NumLock-off keypad navigation keys reach a terminal program",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", { "keypad-probe.mjs": PROBE });
    const thread = await t3.thread({ project, title: "Keypad", messages: ["hello"] });
    const read = (file: string) =>
      runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.readFileString(`${project}/${file}`);
        }).pipe(Effect.orElseSucceed(() => "")),
      );
    await t3.open(thread);

    await screen.getByRole("button", "Toggle terminal drawer").tap();
    const terminal = screen.getByLabel("Terminal input");

    // Input sent before the shell runs is dropped, so retype until it lands.
    await expect
      .poll(
        async () => {
          await terminal.focus();
          await browser.keyboard.type(`echo ready > '${project}/shell-ready'`);
          await browser.keyboard.press("Enter");
          return read("shell-ready");
        },
        { timeout: 30_000 },
      )
      .toBe("ready\n");

    await terminal.focus();
    await browser.keyboard.type(`'${process.execPath}' '${project}/keypad-probe.mjs'`);
    await browser.keyboard.press("Enter");
    await expect.poll(() => read("received"), { timeout: 15_000 }).toBe(READY);

    // The e2e keyboard cannot press a keypad key with NumLock off, so send the events Chromium reports.
    await browser.evaluate((keys) => {
      const input = document.activeElement;
      if (!input) throw new Error("Terminal input lost focus");
      for (const init of keys) {
        for (const type of ["keydown", "keyup"]) {
          const options = { ...init, location: 3, bubbles: true, cancelable: true };
          input.dispatchEvent(new KeyboardEvent(type, options));
        }
      }
      return null;
    }, KEYPAD);
    await browser.keyboard.type("x");
    await app.screenshot("after-keypad");

    await expect
      .poll(() => read("received"), { timeout: 10_000 })
      .toBe(`${READY}\x1bOA\x1bOF\x1b[3~x`);
  },
);
