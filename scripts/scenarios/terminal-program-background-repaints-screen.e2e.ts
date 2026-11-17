/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { runPromise, test, WEB } from "./t3.ts";

// A raw-mode process prints rows, then on `b` sets the default background with OSC 11.
const PROGRAM = String.raw`import { writeFileSync } from "node:fs";

const state = new URL("state", import.meta.url);
process.stdin.setRawMode(true);
process.stdout.write("\x1b[2J\x1b[HROW ONE\r\nROW TWO\r\nROW THREE\r\nROW FOUR\r\n");
writeFileSync(state, "ready");
process.stdin.on("data", (chunk) => {
  const key = chunk.toString();
  if (key === "b") {
    process.stdout.write("\x1b]11;rgb:44/55/66\x07", () => writeFileSync(state, "changed"));
  }
  if (key === "x") {
    process.stdin.setRawMode(false);
    process.exit(0);
  }
});
`;

test(
  "A program setting the terminal's default background repaints the whole screen",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await browser.emulateMedia({ colorScheme: "dark" });
    const project = await t3.project("colors", { "program.mjs": PROGRAM });
    const thread = await t3.thread({ project, title: "Colors", messages: ["hello"] });
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
    await browser.keyboard.type(`'${process.execPath}' '${project}/program.mjs'`);
    await browser.keyboard.press("Enter");
    await expect.poll(() => read("state"), { timeout: 15_000 }).toBe("ready");
    await app.screenshot("before-background");

    await terminal.focus();
    await browser.keyboard.type("b");
    await expect.poll(() => read("state"), { timeout: 15_000 }).toBe("changed");
    await app.screenshot("after-background");

    // Sample the padding above the rows, a cell beside the printed rows, and the canvas bottom.
    const pixels = await browser.evaluate(() => {
      const canvas = document
        .querySelector('[aria-label="Terminal input"]')!
        .parentElement!.querySelector("canvas")!;
      const context = canvas.getContext("2d")!;
      const at = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data];
      return {
        padding: at(canvas.width - 2, 1),
        row: at(canvas.width - 20, Math.floor(canvas.height / 2)),
        bottom: at(canvas.width - 2, canvas.height - 1),
      };
    });
    await browser.keyboard.type("x");
    const programBackground = [68, 85, 102, 255];
    expect(pixels).toEqual({
      padding: programBackground,
      row: programBackground,
      bottom: programBackground,
    });
  },
);
