import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

test(
  "Adding a project to a draft applies the workspace default from t3.json",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const source = await t3.project("source", {
      "next/t3.json": JSON.stringify({ defaultThreadEnvMode: "worktree" }),
    });
    const destination = `${source}/next`;
    const git = (args: ReadonlyArray<string>) => runPromise(run("git", args, { cwd: destination }));
    await git(["init", "--quiet", "--initial-branch=main"]);
    await git(["add", "t3.json"]);
    await git([
      "-c",
      "user.name=Scenario",
      "-c",
      "user.email=scenario@example.invalid",
      "commit",
      "--quiet",
      "--message",
      "Initial commit",
    ]);

    await t3.open();
    const workspace = screen.getByRole("combobox", "Workspace", { exact: true });
    await workspace.getByText("Current checkout").waitFor();
    await screen.getByRole("textbox").fill("Plan the next project");

    try {
      const projectPicker = browser.locator("[data-draft-project-trigger]");
      await projectPicker.tap();
      await screen.getByRole("option", "Add project").tap();
      await screen.getByText("Local folder").tap();
      await screen.getByRole("combobox").fill(destination);
      await browser.keyboard.press("Enter");

      await projectPicker.getByText("next").waitFor();
      await app.screenshot("workspace-after-add");
      await expect(workspace).toHaveText("New worktree");
    } finally {
      await runPromise(
        makeState(T3_HOME)
          .cli(["project", "remove", destination, "--force"])
          .pipe(
            Effect.catchIf(
              (error) => error.message.includes(`No active project found for '${destination}'.`),
              () => Effect.void,
            ),
          ),
      );
    }
  },
);
