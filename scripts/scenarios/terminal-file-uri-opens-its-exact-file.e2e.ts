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

const removeEditorArgs = () =>
  runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(EDITOR_ARGS, { force: true })),
  );

// GNU ls, made hostless, for filenames that end like a position.
const listed = (name: string) =>
  `command ls -d --hyperlink=always --color=never -1 --quoting-style=literal -- '${name}' | sed -E 's@file://[^/]+/@file:///@'`;
// An opaque label, so only the URI can name the file.
const hashed = (uriPath: string) =>
  `printf '\\033]8;;file://%s\\033\\\\CLICKME\\033]8;;\\033\\\\\\n' "$PWD/${uriPath}"`;

const LINKS = [
  { print: listed("report.txt:12-64"), opens: ["report.txt:12-64"] },
  { print: listed("zero.txt:0"), opens: ["zero.txt:0"] },
  { print: hashed("numeric.txt%3A12#L5"), opens: ["numeric.txt:12"] },
  { print: hashed("position.txt#L5C3"), opens: ["--goto", "position.txt:5:3"] },
  { print: listed("build:2026"), opens: ["--new-window", "build:2026"] },
];

test(
  "Ctrl+click on a terminal file URI opens the exact file it names, even one ending like a position",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await removeEditorArgs();
    const files: Record<string, string> = {
      "build:2026/keep.txt": "keep\n",
      "numeric.txt:12:1:1/keep.txt": "decoy\n",
    };
    for (const name of ["report.txt:12-64", "zero.txt:0", "numeric.txt:12", "position.txt"]) {
      files[name] = `${name}\n`;
    }
    // Enough rows to scroll, so every row is the link. Scripts keep the typed commands short.
    for (const [index, link] of LINKS.entries()) {
      files[`print-${index}.sh`] =
        `for i in $(seq 1 100); do ${link.print}; done; touch printed-${index}\n`;
    }
    const project = await t3.project("demo", files);
    const thread = await t3.thread({ project, title: "List", messages: ["List it"] });
    await t3.open(thread);

    await screen.getByRole("button", "Toggle terminal drawer").tap();
    const input = screen.getByRole("textbox", "Terminal input");
    // The input mounts before fonts and WASM finish loading and its handlers are installed.
    await expect(input).toHaveAttribute("data-workspace-focus-default", "");

    for (const [index, { opens }] of LINKS.entries()) {
      await removeEditorArgs();
      await input.focus();
      await browser.keyboard.type(`bash print-${index}.sh\n`);
      await expect
        .poll(() => readLines(`${project}/printed-${index}`), { timeout: 30_000 })
        .toEqual([""]);
      await app.screenshot(`printed-${index}`);

      // The terminal draws on a canvas, so point at the first cells of a row near its middle.
      const canvas = await browser.evaluate(() => {
        const box = document
          .querySelector('[aria-label="Terminal input"]')
          ?.parentElement?.querySelector("canvas")
          ?.getBoundingClientRect();
        return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
      });
      if (!canvas) throw new Error("The terminal canvas is not on the page.");
      // Alternate rows, or a quick second click on the same spot counts as a double-click.
      await browser.mouse.move(canvas.x + 16, canvas.y + canvas.height / 2 - (index % 2) * 40);
      await browser.keyboard.down("Control");
      await browser.mouse.down();
      await browser.mouse.up();
      await browser.keyboard.up("Control");

      await expect
        .poll(() => readLines(EDITOR_ARGS), { timeout: 15_000 })
        .toEqual(["--classic", ...opens.slice(0, -1), `${project}/${opens.at(-1)}`]);
    }
  },
);
