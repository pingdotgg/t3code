/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

const SOCKET = `t3-scenario-divider-${process.pid}`;

const tmux = (...args: ReadonlyArray<string>) =>
  runPromise(
    run("tmux", ["-L", SOCKET, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      allowExit: [0, 1],
    }),
  );

const paneWidths = async () =>
  (await tmux("list-panes", "-F", "#{pane_width}")).stdout.trim().split("\n").filter(Boolean);

test(
  "Dragging a tmux pane divider in the web terminal resizes the panes",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Panes", messages: ["hello"] });
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

    try {
      await terminal.focus();
      await browser.keyboard.type(
        `tmux -L ${SOCKET} -f /dev/null new-session \\; set -g mouse on \\; set -g status off \\; split-window -h -l 30%`,
      );
      await browser.keyboard.press("Enter");
      await expect.poll(async () => (await paneWidths()).length, { timeout: 15_000 }).toBe(2);
      const [leftWidth] = await paneWidths();

      // Find the divider tmux drew from the canvas pixels of an empty row, not from cell math.
      const findDivider = () =>
        browser.evaluate(() => {
          const input = document.querySelector('textarea[aria-label="Terminal input"]');
          const canvas = input?.parentElement?.querySelector("canvas");
          const context = canvas?.getContext("2d");
          if (!canvas || !context) return null;
          const bounds = canvas.getBoundingClientRect();
          const ratio = canvas.width / bounds.width;
          const row = Math.floor(canvas.height * 0.75);
          const pixels = context.getImageData(0, row, canvas.width, 1).data;
          const lit: number[] = [];
          for (let x = 0; x < canvas.width; x += 1) {
            const offset = x * 4;
            const difference =
              Math.abs(pixels[offset]! - pixels[0]!) +
              Math.abs(pixels[offset + 1]! - pixels[1]!) +
              Math.abs(pixels[offset + 2]! - pixels[2]!);
            if (difference > 90) lit.push(x);
          }
          const first = lit[0];
          const last = lit.at(-1);
          if (first === undefined || last === undefined || last - first > 4 * ratio) return null;
          return {
            x: bounds.left + (first + last + 1) / 2 / ratio,
            y: bounds.top + (row + 0.5) / ratio,
          };
        });
      await expect.poll(findDivider, { timeout: 10_000 }).not.toBeNull();
      const divider = (await findDivider())!;
      await app.screenshot("before-drag");

      await browser.mouse.move(divider.x, divider.y);
      await browser.mouse.down();
      for (let step = 1; step <= 8; step += 1) {
        await browser.mouse.move(divider.x - step * 10, divider.y);
      }
      await browser.mouse.up();

      await app.screenshot("after-drag");
      await expect
        .poll(async () => Number((await paneWidths())[0]), { timeout: 5_000 })
        .toBeLessThan(Number(leftWidth));
    } finally {
      await tmux("kill-server");
    }
  },
);
