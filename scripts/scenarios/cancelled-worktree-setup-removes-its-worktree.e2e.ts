import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

const decodeLaunched = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ threadId: Schema.String })),
);

test(
  "Cancelling worktree setup during its post-checkout hook removes the new worktree",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    const git = (...args: ReadonlyArray<string>) =>
      runPromise(run("git", args, { cwd: project })).then(({ stdout }) => stdout);
    // The hook reports a percent no real checkout of one file shows, then holds the setup open.
    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const hook = `${project}/.git/hooks/post-checkout`;
        const fifo = `${project}/hook-gate`;
        yield* run("mkfifo", [fifo]);
        yield* fs.writeFileString(
          hook,
          `#!/bin/sh\nprintf 'Updating files:  50%% (1/1000)\\n' >&2\nread ignored < '${fifo}'\n`,
        );
        yield* fs.chmod(hook, 0o755);
      }),
    );
    const started = await runPromise(
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
          "--provider",
          "devReplay",
          "--model",
          "showcase",
          "--json",
          "--base-dir",
          T3_HOME,
        ],
        { cwd: APP_DIR, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
      ).pipe(Effect.flatMap(({ stdout }) => decodeLaunched(stdout))),
    );

    await t3.open(started);
    await expect(screen.getByText("50%")).toBeVisible();
    await screen.getByRole("button", "Cancel").tap();
    await app.screenshot("after-cancel");

    // The project's own checkout is the only one left once the cancel has cleaned up.
    await expect
      .poll(
        async () => (await git("worktree", "list", "--porcelain")).match(/^worktree /gm)?.length,
      )
      .toBe(1);
    await expect.poll(() => git("branch", "--list", "t3/*")).toBe("");
  },
);
