import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

const decodeLaunched = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ threadId: Schema.String })),
);

test(
  "The Files panel says a removed worktree is gone instead of loading forever",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo", { "README.md": "Example project" });
    const git = (...args: ReadonlyArray<string>) =>
      runPromise(run("git", args, { cwd: project })).then(({ stdout }) => stdout);
    const thread = await runPromise(
      run(
        process.execPath,
        [
          "apps/server/src/bin.ts",
          "thread",
          "start",
          project,
          "hello",
          "--worktree",
          "main",
          "--branch",
          "t3/removed-worktree",
          "--provider",
          "devReplay",
          "--model",
          "multi-turn",
          "--wait",
          "--json",
          "--base-dir",
          T3_HOME,
        ],
        { cwd: APP_DIR, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
      ).pipe(Effect.flatMap(({ stdout }) => decodeLaunched(stdout))),
    );
    // Storage cleanup leaves the same state: the thread keeps the path of a checkout that is gone.
    const worktree = (await git("worktree", "list", "--porcelain"))
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .find((path) => path !== project);
    if (worktree === undefined) throw new Error("The thread has no worktree");
    await git("worktree", "remove", "--force", worktree);

    await t3.open(thread);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();
    await screen.getByRole("button", "Toggle right panel").tap();
    await screen.getByText("Files").tap();
    try {
      await expect(
        screen.getByText("sending a message recreates it", { exact: false }),
      ).toBeVisible();
      await expect(screen.getByText("Loading files…")).toBeHidden();
    } finally {
      await app.screenshot("files-panel-after-worktree-removal");
    }
  },
);
