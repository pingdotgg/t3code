/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

// The scenario home's `bin` leads the server's PATH, so this `code` is the editor it launches.
const recorder = (log: string) =>
  `#!/bin/sh\n[ "$1" = "--version" ] && echo 1.99.0 && exit 0\nprintf '%s\\n' "$*" >> '${log}'\n`;

test(
  "A relative terminal link opens the file in the directory the shell moved to",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const log = `${T3_HOME}/editor.log`;
    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const code = path.join(T3_HOME, "bin", "code");
        yield* fs.makeDirectory(path.dirname(code), { recursive: true });
        yield* fs.writeFileString(code, recorder(log));
        yield* fs.chmod(code, 0o755);
        yield* fs.writeFileString(log, "");
      }),
    );
    const read = (file: string) =>
      runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.readFileString(file);
        }).pipe(Effect.orElseSucceed(() => "")),
      );
    // Both directories hold a package.json, so resolving against the wrong one still finds a file.
    const project = await t3.project("demo", {
      "package.json": '{\n  "name": "launch-dir"\n}\n',
      "sub/package.json": '{\n  "name": "shell-dir"\n}\n',
    });
    const thread = await t3.thread({ project, title: "Links", messages: ["hello"] });
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
          return read(`${project}/shell-ready`);
        },
        { timeout: 30_000 },
      )
      .toBe("ready\n");

    // Clearing first puts grep's line on the top row, where the pointer can find it.
    await browser.keyboard.type(
      `cd sub && printf '\\033[2J\\033[3J\\033[H' && grep -nH name ./package.json; echo done > '${project}/grep-done'`,
    );
    await browser.keyboard.press("Enter");
    await expect.poll(() => read(`${project}/grep-done`), { timeout: 15_000 }).toBe("done\n");

    // The hidden input follows the cursor, now on the prompt row just below grep's line.
    const point = await browser.evaluate(() => {
      const input = document.querySelector<HTMLElement>('[aria-label="Terminal input"]');
      const canvas = input?.parentElement?.querySelector("canvas");
      if (!input || !canvas) return null;
      const cursor = input.getBoundingClientRect();
      const bounds = canvas.getBoundingClientRect();
      return { x: bounds.left + 24, y: cursor.top - cursor.height / 2 };
    });
    expect(point).not.toBeNull();
    if (!point) return;
    await browser.mouse.move(point.x, point.y);
    await app.screenshot("hovered-link");
    await browser.mouse.down();
    await browser.mouse.up();

    await expect.poll(() => read(log), { timeout: 15_000 }).toContain("package.json:2");
    expect((await read(log)).trim()).toBe(`--goto ${project}/sub/package.json:2`);
  },
);
