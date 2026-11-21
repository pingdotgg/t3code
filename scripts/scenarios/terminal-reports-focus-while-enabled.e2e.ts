/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { runPromise, test, WEB } from "./lathe.ts";

// One raw-mode process logs every byte the terminal sends to `received` and steps on exact
// input: DECRQM replies mark when 1004 is on or off, and `x` ends it.
const PROBE = String.raw`import { appendFileSync, writeFileSync } from "node:fs";

const log = new URL("received", import.meta.url);
const ENABLED = "\x1b[?1004;1$y";
const REPORTS = "\x1b[O\x1b[I";
const DISABLED = "\x1b[?1004;2$y";
let received = "";

writeFileSync(log, "");
process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  appendFileSync(log, chunk);
  received += chunk.toString("latin1");
  if (received === ENABLED + REPORTS) process.stdout.write("\x1b[?1004l\x1b[?1004$p");
  if (received === ENABLED + REPORTS + DISABLED + "x") {
    process.stdin.setRawMode(false);
    process.exit(0);
  }
});
process.stdout.write("\x1b[?1004h\x1b[?1004$p");
`;

const ENABLED = "\x1b[?1004;1$y";
const REPORTS = "\x1b[O\x1b[I";
const DISABLED = "\x1b[?1004;2$y";

test(
  "The web terminal reports focus changes only while a program enables DEC 1004",
  WEB,
  async ({ lathe, app, browser, screen }) => {
    const project = await lathe.project("demo", { "focus-probe.mjs": PROBE });
    const thread = await lathe.thread({ project, title: "Focus", messages: ["hello"] });
    const read = (file: string) =>
      runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.readFileString(`${project}/${file}`);
        }).pipe(Effect.orElseSucceed(() => "")),
      );
    await lathe.open(thread);
    await browser.evaluate(() => {
      localStorage.setItem("lathe:theme", "dark");
      return null;
    });
    await lathe.open(thread);

    await screen.getByRole("button", "Toggle terminal drawer").tap();
    const terminal = screen.getByLabel("Terminal input");
    const composer = screen.getByRole("textbox", "Message Focus");

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
    await browser.keyboard.type(`'${process.execPath}' '${project}/focus-probe.mjs'`);
    await browser.keyboard.press("Enter");
    await expect.poll(() => read("received"), { timeout: 15_000 }).toBe(ENABLED);

    await composer.tap();
    await terminal.focus();
    await app.screenshot("enabled");
    await expect
      .poll(() => read("received"), { timeout: 10_000 })
      .toBe(ENABLED + REPORTS + DISABLED);

    await composer.tap();
    await terminal.focus();
    await browser.keyboard.type("x");
    await app.screenshot("disabled");
    await expect
      .poll(() => read("received"), { timeout: 10_000 })
      .toBe(ENABLED + REPORTS + DISABLED + "x");
  },
);
