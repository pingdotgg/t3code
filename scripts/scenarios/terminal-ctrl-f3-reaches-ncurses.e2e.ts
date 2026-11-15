import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { runPromise, test, WEB } from "./t3.ts";

// A real ncurses program, reading keys through the PTY's advertised xterm-256color terminfo,
// logs each key's name to `received` and exits on `q`.
const PROBE = String.raw`import curses, pathlib

here = pathlib.Path(__file__).parent

def run(screen):
    screen.keypad(True)
    (here / "received").write_text("")
    (here / "ready").write_text("ready")
    while True:
        key = screen.get_wch()
        if key == "q":
            break
        name = curses.keyname(key if isinstance(key, int) else ord(key)).decode()
        with (here / "received").open("a") as log:
            log.write(name + "\n")

curses.wrapper(run)
`;

test(
  "Ctrl+F3 in the web terminal reaches an ncurses program as KEY_F(27)",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await browser.emulateMedia({ colorScheme: "dark" });
    const project = await t3.project("demo", { "keys-probe.py": PROBE });
    const thread = await t3.thread({ project, title: "Keys", messages: ["hello"] });
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
    await browser.keyboard.type(`python3 '${project}/keys-probe.py'`);
    await browser.keyboard.press("Enter");
    await expect.poll(() => read("ready"), { timeout: 15_000 }).toBe("ready");

    await browser.keyboard.press("Control+F1");
    await browser.keyboard.press("Control+F3");
    await browser.keyboard.press("Control+F4");
    await app.screenshot("after-ctrl-f3");
    await expect
      .poll(() => read("received"), { timeout: 10_000 })
      .toBe("KEY_F(25)\nKEY_F(27)\nKEY_F(28)\n");
    await browser.keyboard.press("q");
  },
);
