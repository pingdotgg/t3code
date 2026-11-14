import { expect } from "e2e";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

test(
  "A scheduled task created in Settings can return to the default base after choosing a branch and saves the project's default branch",
  WEB,
  async ({ t3, screen, app }) => {
    const project = await t3.project("demo");
    await runPromise(run("git", ["branch", "--move", "main", "master"], { cwd: project }));

    await runPromise(run("git", ["remote", "add", "origin", project], { cwd: project }));
    await runPromise(
      run("git", ["update-ref", "refs/remotes/origin/master", "HEAD"], { cwd: project }),
    );
    await runPromise(
      run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"], {
        cwd: project,
      }),
    );

    await t3.open("/settings/scheduled-tasks");
    await screen.getByRole("button", "New task").tap();
    await screen.getByPlaceholder("e.g. Check for Sentry issues").fill("Nightly review");
    await screen.getByPlaceholder("What should the agent do each time this runs?").fill("Review");
    await screen.getByRole("combobox", "Base branch").tap();
    await screen.getByRole("option", "master current").tap();
    await screen.getByRole("combobox", "Base branch").tap();
    const defaultBranch = screen.getByRole("button", "Default branch");
    await expect(defaultBranch).toBeVisible();
    await defaultBranch.tap();
    await screen.getByRole("button", "Create task").tap();

    await screen.getByRole("button", "Actions for Nightly review").tap();
    await screen.getByRole("menuitem", "Edit").tap();
    // The trigger splits its label in two for middle truncation, so read the picker's selection.
    await screen.getByRole("combobox", "Base branch").tap();
    const master = screen.getByRole("option", "origin/ master remote");
    await expect(master).toBeVisible();
    await app.screenshot("saved-base");
    await expect(master).toBeSelected();
  },
);
