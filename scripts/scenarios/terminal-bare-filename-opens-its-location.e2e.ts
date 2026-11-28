/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

// gcc prints a file compiled from its own folder by bare name.
const DIAGNOSTIC = "main.c:1:25: error: 'missing' undeclared";
const EDITOR_ARGS = `${T3_HOME}/editor-args.txt`;

const hostPath = (...segments: ReadonlyArray<string>) =>
  runPromise(Effect.map(Path.Path, (path) => path.join(...segments)));

/** The file's lines, or none while it does not exist. */
const readLines = (file: string) =>
  runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(file))) return [];
      return (yield* fs.readFileString(file)).trim().split("\n");
    }),
  );

test(
  "Ctrl+click on a bare compiler filename in the terminal opens that file at its line and column",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(EDITOR_ARGS, { force: true })),
    );
    const project = await t3.project("demo", {
      "main.c": "int main(void) { return missing; }\n",
      // Enough rows that the middle of the terminal shows the diagnostic, whatever its height.
      "build.log": `${DIAGNOSTIC}\n`.repeat(200),
    });
    const thread = await t3.thread({ project, title: "Build", messages: ["Build it"] });
    await t3.open(thread);

    await screen.getByRole("button", "Toggle terminal drawer").tap();
    const input = screen.getByRole("textbox", "Terminal input");
    // The input mounts before fonts and WASM finish loading and its handlers are installed.
    await expect(input).toHaveAttribute("data-workspace-focus-default", "");
    await input.focus();
    await browser.keyboard.type("cat build.log; echo done > cat.done\n");
    await expect.poll(() => readLines(`${project}/cat.done`), { timeout: 30_000 }).not.toEqual([]);
    await app.screenshot("diagnostic-printed");

    // The terminal draws on a canvas, so point at the first cells of its middle row.
    const canvas = await browser.evaluate(() => {
      const box = document
        .querySelector('[aria-label="Terminal input"]')
        ?.parentElement?.querySelector("canvas")
        ?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    });
    if (!canvas) throw new Error("The terminal canvas is not on the page.");
    await browser.mouse.move(canvas.x + 16, canvas.y + canvas.height / 2);
    await browser.keyboard.down("Control");
    await browser.mouse.down();
    await browser.mouse.up();
    await browser.keyboard.up("Control");
    await app.screenshot("after-ctrl-click");

    await expect
      .poll(() => readLines(EDITOR_ARGS), { timeout: 15_000 })
      .toEqual(["--classic", "--goto", `${await hostPath(project, "main.c")}:1:25`]);
  },
);
