/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { runPromise, test, WEB } from "./t3.ts";

// DECRQM replies only after the terminal applied each mode, so the files mark when the browser
// has 1004 on or off. Raw reads keep the shell's line editor from swallowing the reports.
const PROBE = `cd "$(dirname "$0")"
stty -icanon -echo min 1 time 0
printf '\\033[?1004h\\033[?1004$p'
dd bs=1 count=11 of=enabled-reply 2>/dev/null
dd bs=1 count=6 of=reports 2>/dev/null
printf '\\033[?1004l\\033[?1004$p'
dd bs=1 count=11 of=disabled-reply 2>/dev/null
dd bs=1 count=1 of=after 2>/dev/null
stty sane
`;

test(
  "The web terminal reports focus changes only while a program enables DEC 1004",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", { "focus-probe.sh": PROBE });
    const thread = await t3.thread({ project, title: "Focus", messages: ["hello"] });
    // Each probe file appears only once its reply or report arrived.
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
    const blur = () =>
      browser.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        return null;
      });

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

    await browser.keyboard.type(`sh '${project}/focus-probe.sh'`);
    await browser.keyboard.press("Enter");
    await expect.poll(() => read("enabled-reply"), { timeout: 15_000 }).toBe("\x1b[?1004;1$y");

    await blur();
    await terminal.focus();
    await app.screenshot("enabled");
    await expect.poll(() => read("reports"), { timeout: 10_000 }).toBe("\x1b[O\x1b[I");

    await expect.poll(() => read("disabled-reply"), { timeout: 15_000 }).toBe("\x1b[?1004;2$y");
    await blur();
    await terminal.focus();
    await browser.keyboard.type("x");
    await app.screenshot("disabled");
    await expect.poll(() => read("after"), { timeout: 10_000 }).toBe("x");
  },
);
