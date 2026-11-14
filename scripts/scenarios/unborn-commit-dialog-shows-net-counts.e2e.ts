import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

test(
  "The commit dialog before the first commit counts a file staged then edited once",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    const git = (...args: ReadonlyArray<string>) => runPromise(run("git", args, { cwd: project }));
    const write = (text: string) =>
      runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString(`${project}/new.txt`, `${text}\n`),
        ),
      );
    // No commits yet: staged "staged", then edited to "actual" without restaging.
    await git("update-ref", "-d", "HEAD");
    await git("rm", "-r", "--cached", "--quiet", ".");
    await write("staged");
    await git("add", "new.txt");
    await write("actual");
    const thread = await t3.thread({ project, title: "First commit", messages: ["first"] });

    await t3.open(thread);
    await screen.getByRole("button", "Git action options").tap();
    await screen.getByRole("menuitem", "Commit").tap();
    const row = screen.getByRole("button", "Open new.txt in editor");
    await expect(row).toBeVisible();
    await app.screenshot("commit-dialog");
    await expect(row).toHaveText(/\+1 \/ -0/);
  },
);
