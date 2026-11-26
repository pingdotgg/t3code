import * as NodeAssert from "node:assert/strict";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

for (const { title, newBranch, committedFiles, remainingStatus } of [
  {
    title: "A partial commit retry still excludes files restored from a stash",
    newBranch: null,
    committedFiles: "include.txt",
    remainingStatus: "?? later.txt",
  },
  {
    title: "A different branch starts with a fresh selection after a failed commit",
    newBranch: "other-branch",
    committedFiles: "include.txt\nlater.txt",
    remainingStatus: "",
  },
]) {
  test(title, WEB, async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Partial commit", messages: ["Start"] });

    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const hook = `${project}/.git/hooks/pre-commit`;
        yield* fs.writeFileString(hook, "#!/bin/sh\necho rejected > .git/retry-hook-ran\nexit 1\n");
        yield* fs.chmod(hook, 0o755);
        yield* run("git", ["config", "core.hooksPath", ".git/hooks"], { cwd: project });
        yield* run("git", ["config", "user.name", "Scenario"], { cwd: project });
        yield* run("git", ["config", "user.email", "scenario@example.invalid"], { cwd: project });
        yield* fs.writeFileString(`${project}/include.txt`, "Include this change\n");
        yield* fs.writeFileString(`${project}/later.txt`, "Save this change for later\n");
      }),
    );

    await t3.open(thread);
    const gitMenu = screen.getByRole("button", "Git action options");
    const commitItem = screen.getByRole("menuitem", "Commit", { exact: true });
    const openCommit = async () => {
      await gitMenu.tap();
      await expect(commitItem).toBeEnabled();
      await commitItem.tap();
      await screen.getByRole("button", "Open later.txt in editor").waitFor();
    };
    const laterFile = screen.getByRole("button", "Open later.txt in editor");
    await openCommit();
    await screen.getByRole("button", "Edit", { exact: true }).tap();
    await screen.getByRole("checkbox", "Include later.txt").tap();
    await laterFile.getByText("Excluded", { exact: true }).waitFor();
    await screen.getByPlaceholder("Leave empty to auto-generate").fill("Commit the first change");
    await screen.getByRole("button", "Commit", { exact: true }).tap();
    await screen.getByText("Action failed", { exact: true }).waitFor();

    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        NodeAssert.equal(
          (yield* fs.readFileString(`${project}/.git/retry-hook-ran`)).trim(),
          "rejected",
        );
        yield* fs.remove(`${project}/.git/hooks/pre-commit`);
      }),
    );

    await runPromise(run("git", ["stash", "push", "--include-untracked"], { cwd: project }));
    await gitMenu.tap();
    await expect(commitItem).toBeDisabled();
    await browser.keyboard.press("Escape");
    await runPromise(
      Effect.gen(function* () {
        if (newBranch) {
          yield* run("git", ["switch", "-c", newBranch], { cwd: project });
        }
        yield* run("git", ["stash", "pop"], { cwd: project });
      }),
    );

    await openCommit();
    await app.screenshot("restored-files-in-commit-retry");
    await expect(laterFile).toHaveText(newBranch ? /later\.txt\s*\+/ : /Excluded/);
    await screen.getByRole("button", "Commit", { exact: true }).tap();
    await screen.getByText(/^Committed [0-9a-f]+$/).waitFor();

    await runPromise(
      Effect.gen(function* () {
        const committed = yield* run(
          "git",
          ["ls-tree", "--name-only", "HEAD", "--", "include.txt", "later.txt"],
          { cwd: project },
        );
        NodeAssert.equal(committed.stdout.trim(), committedFiles);
        const status = yield* run("git", ["status", "--porcelain", "--", "later.txt"], {
          cwd: project,
        });
        NodeAssert.equal(status.stdout.trim(), remainingStatus);
      }),
    );
  });
}
