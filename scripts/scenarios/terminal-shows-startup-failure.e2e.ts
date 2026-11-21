/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

const decodeRuntime = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int })),
);

/** The scenario's own server: the pid its T3 home records, running from the app checkout. */
const scenarioServerPid = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtime = yield* Effect.firstSuccessOf(
    ["userdata", "dev"].map((dir) =>
      fs.readFileString(path.join(T3_HOME, dir, "server-runtime.json")),
    ),
  );
  const { pid } = yield* decodeRuntime(runtime);
  const cwd = yield* fs.readLink(`/proc/${pid}/cwd`);
  if (!cwd.startsWith(path.resolve(APP_DIR))) {
    return yield* Effect.die(new Error(`pid ${pid} runs in ${cwd}, not ${APP_DIR}`));
  }
  return pid;
});

/**
 * Linux only: leaves the server no free file descriptor, so node-pty's forkpty(3) fails as it does when a
 * host runs out. Returns the restore; only this process's soft limit changes.
 */
const exhaustFileDescriptors = Effect.fn("scenario.exhaustFileDescriptors")(function* (
  pid: number,
) {
  const limits = yield* run("prlimit", [
    `--pid=${pid}`,
    "--nofile",
    "--raw",
    "--noheadings",
    "--output=SOFT,HARD",
  ]);
  const [soft = "", hard = ""] = limits.stdout.trim().split(/\s+/);
  yield* run("prlimit", [`--pid=${pid}`, `--nofile=0:${hard}`]);
  return run("prlimit", [`--pid=${pid}`, `--nofile=${soft}:${hard}`]);
});

test(
  "A terminal whose shell cannot start says why, also after its drawer reopens",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Shell", messages: ["hello"] });
    await t3.open(thread);
    const pid = await runPromise(scenarioServerPid);

    const toggle = screen.getByRole("button", "Toggle terminal drawer");
    const terminal = screen.getByLabel("Terminal input");
    // The canvas has no DOM text: select all and read what the terminal's copy hands over.
    const terminalText = async () => {
      await browser.evaluate(() => {
        delete document.body.dataset.terminalCopy;
        window.addEventListener(
          "copy",
          (event) => {
            document.body.dataset.terminalCopy = event.clipboardData?.getData("text/plain") ?? "";
          },
          { once: true },
        );
        return null;
      });
      await terminal.focus();
      await browser.keyboard.press("Control+Shift+A");
      await browser.keyboard.press("Control+Shift+C");
      return browser.evaluate(() => document.body.dataset.terminalCopy ?? "");
    };

    await expect(toggle).toBeVisible();
    const restore = await runPromise(exhaustFileDescriptors(pid));
    try {
      await toggle.tap();
      await expect.poll(terminalText, { timeout: 15_000 }).toContain("Failed to spawn PTY process");
    } finally {
      await runPromise(restore);
    }
    await app.screenshot("startup-failure");

    await toggle.tap();
    await expect(terminal).toBeHidden();
    await toggle.tap();
    await expect.poll(terminalText, { timeout: 15_000 }).toContain("Failed to spawn PTY process");
    await app.screenshot("after-reopen");
  },
);
