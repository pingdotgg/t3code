import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

const utf16 = (text: string) => Buffer.from(`\ufeff${text}`, "utf16le");

test(
  "The commit dialog refuses a merge whose UTF-16 file still has conflict markers",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo", {
      ".gitattributes": "README.md text working-tree-encoding=UTF-16\n",
      "README.md": utf16("base\n"),
    });
    const git = (args: ReadonlyArray<string>, allowExit: ReadonlyArray<number> = [0]) =>
      runPromise(
        run(
          "git",
          ["-c", "user.name=Scenario", "-c", "user.email=scenario@example.invalid", ...args],
          { cwd: project, allowExit },
        ),
      );
    const commitReadme = async (text: string) => {
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFile(`${project}/README.md`, utf16(text)),
        ),
      );
      await git(["commit", "--quiet", "--all", "--message", text.trim()]);
    };
    await git(["checkout", "--quiet", "-b", "feature"]);
    await commitReadme("feature version\n");
    await git(["checkout", "--quiet", "main"]);
    await commitReadme("main version\n");
    await git(["merge", "--quiet", "feature"], [1]);
    const thread = await t3.thread({ project, title: "Merge", messages: ["merge"] });

    await t3.open(thread);
    await screen.getByRole("button", "Git action options").tap();
    await screen.getByRole("menuitem", "Commit").tap();
    await screen.getByPlaceholder("Leave empty to auto-generate").fill("Finish merge");
    await screen.getByRole("button", "Commit", { exact: true }).tap();
    // On a failed assertion e2e captures the committed merge itself.
    await expect(
      screen.getByText("unresolved merge conflicts in README.md", { exact: false }),
    ).toBeVisible();
    await app.screenshot("refused");
  },
);
