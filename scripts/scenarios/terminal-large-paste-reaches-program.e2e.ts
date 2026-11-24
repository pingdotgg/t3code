/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { runPromise, test, WEB } from "./t3.ts";

// A raw-mode program that turns on bracketed paste, logs every byte it receives to `received`,
// and exits once the paste's closing marker arrives.
const PROBE = String.raw`import { appendFileSync, writeFileSync } from "node:fs";

const log = new URL("received", import.meta.url);
let tail = "";
let bytes = 0;

writeFileSync(log, "");
process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  appendFileSync(log, chunk);
  bytes += chunk.length;
  tail = (tail + chunk.toString("latin1")).slice(-6);
  if (tail === "\x1b[201~") {
    process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?2004l\r\nreceived " + bytes + " bytes\r\n");
    process.exit(0);
  }
});
process.stdout.write("\x1b[?2004h");
writeFileSync(new URL("ready", import.meta.url), "ready");
`;

// Over the 65,536-unit write limit, multiline, with a surrogate pair straddling the first
// 65,536-unit boundary of the bracketed paste (6 units of ESC[200~ come first).
const LINE = '  {"file":"src/日本語.ts","message":"café changes"},\n';
const EMOJI_LINE = '  {"user":"🧑🏽‍💻","note":"naïve 𝔘𝔫𝔦𝔠𝔬𝔡𝔢"},\n';
const HEAD = LINE.repeat(Math.ceil(65_529 / LINE.length)).slice(0, 65_529);
const PASTE = HEAD + "🧑🏽‍💻" + EMOJI_LINE.repeat(Math.ceil(34_000 / EMOJI_LINE.length));
const EXPECTED = Buffer.from("\x1b[200~" + PASTE + "\x1b[201~");
const compare = (received: Uint8Array) => ({
  bytes: received.length,
  intact: EXPECTED.equals(received),
});

test(
  "A web terminal paste larger than one write reaches the program intact",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await browser.emulateMedia({ colorScheme: "dark" });
    const project = await t3.project("demo", { "paste-probe.mjs": PROBE });
    const thread = await t3.thread({ project, title: "Paste", messages: ["hello"] });
    const read = (file: string) =>
      runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.readFileString(`${project}/${file}`);
        }).pipe(Effect.orElseSucceed(() => "")),
      );
    const received = () =>
      runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return compare(yield* fs.readFile(`${project}/received`));
        }).pipe(Effect.orElseSucceed(() => compare(new Uint8Array()))),
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
    await browser.keyboard.type(`'${process.execPath}' '${project}/paste-probe.mjs'`);
    await browser.keyboard.press("Enter");
    await expect.poll(() => read("ready"), { timeout: 15_000 }).toBe("ready");

    await browser.evaluate((text) => {
      const input = document.querySelector('[aria-label="Terminal input"]');
      if (!input) throw new Error("no terminal input");
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      return null;
    }, PASTE);

    await expect
      .poll(received, { timeout: 20_000 })
      .toEqual({ bytes: EXPECTED.length, intact: true });
    await app.screenshot("pasted");
  },
);
