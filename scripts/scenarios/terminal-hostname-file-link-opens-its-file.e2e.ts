/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

const EDITOR_ARGS = `${T3_HOME}/editor-args.txt`;

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
  "Ctrl+click on a GNU ls --hyperlink filename, whose file URI names this machine, opens that file",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(EDITOR_ARGS, { force: true })),
    );
    const project = await t3.project("demo", { "one.txt": "hello\n" });
    const thread = await t3.thread({ project, title: "List", messages: ["List it"] });
    await t3.open(thread);

    await screen.getByRole("button", "Toggle terminal drawer").tap();
    const input = screen.getByRole("textbox", "Terminal input");
    // The input mounts before fonts and WASM finish loading and its handlers are installed.
    await expect(input).toHaveAttribute("data-workspace-focus-default", "");
    await input.focus();
    // GNU ls writes `file://<hostname>/<path>`. Enough rows to scroll, so every row is the link.
    await browser.keyboard.type(
      "for i in $(seq 1 100); do command ls --hyperlink=always --color=never -1 one.txt; done; touch ls.done\n",
    );
    await expect.poll(() => readLines(`${project}/ls.done`), { timeout: 30_000 }).toEqual([""]);
    await browser.setViewport({ width: 1000, height: 700 });
    await app.screenshot("listed-and-resized");

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
      .toEqual(["--classic", `${project}/one.txt`]);
  },
);
