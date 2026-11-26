import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

test(
  "A draft moved into a newly added project takes its workspace default",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const source = await t3.project("source", { "next/README.md": "" });
    const destination = `${source}/next`;
    const git = (args: ReadonlyArray<string>) => runPromise(run("git", args, { cwd: destination }));
    await git(["init", "--quiet", "--initial-branch=main"]);
    await git(["add", "README.md"]);
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

    // Changing the fallback leaves the open source draft's implicit workspace alone.
    const setDefault = (defaultThreadEnvMode: "local" | "worktree" | null) =>
      runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
            const previous = yield* client["server.getSettings"]({});
            yield* client["server.updateSettings"]({ patch: { defaultThreadEnvMode } });
            return previous.defaultThreadEnvMode;
          }),
        ),
      );
    const previous = await setDefault("worktree");

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
      await setDefault(previous);
      await runPromise(makeState(T3_HOME).cli(["project", "remove", destination, "--force"]));
    }
  },
);
