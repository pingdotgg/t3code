import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

test(
  "A failed partial commit keeps excluded files out of the retry",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Partial commit", messages: ["Start"] });

    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const hook = `${project}/.git/hooks/pre-commit`;
        yield* fs.writeFileString(hook, "#!/bin/sh\necho 'Commit rejected by hook' >&2\nexit 1\n");
        yield* fs.chmod(hook, 0o755);
        yield* run("git", ["config", "core.hooksPath", ".git/hooks"], { cwd: project });
        yield* run("git", ["config", "user.name", "Scenario"], { cwd: project });
        yield* run("git", ["config", "user.email", "scenario@example.invalid"], { cwd: project });
        yield* fs.writeFileString(`${project}/include.txt`, "Include this change\n");
        yield* fs.writeFileString(`${project}/later.txt`, "Save this change for later\n");
      }),
    );

    await t3.open(thread);
    const openCommit = async () => {
      await screen.getByRole("button", "Git action options").tap();
      await screen.getByRole("menuitem", "Commit", { exact: true }).tap();
      await screen.getByRole("button", "Open later.txt in editor").waitFor();
    };
    const laterFile = screen.getByRole("button", "Open later.txt in editor");
    await openCommit();
    await screen.getByRole("button", "Edit", { exact: true }).tap();
    await screen.getByRole("checkbox", "Include later.txt").tap();
    await laterFile.getByText("Excluded", { exact: true }).waitFor();
    await screen.getByPlaceholder("Leave empty to auto-generate").fill("Commit the first change");
    await screen.getByRole("button", "Commit", { exact: true }).tap();
    const failure = screen.getByText("Action failed", { exact: true });
    await failure.waitFor();
    await screen.getByRole("button", "Dismiss notification", { exact: true }).tap();
    await failure.waitFor({ state: "detached" });

    await openCommit();
    await app.screenshot("file-selection-after-failed-commit");
    await expect(laterFile).toHaveText(/Excluded/);
  },
);
