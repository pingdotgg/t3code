import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { T3_HOME } from "../e2e.config.ts";
import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { run } from "./shell.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

test(
  "A new draft keeps its selected models when it moves to another machine",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const primary = makeState(T3_HOME);
    const second = makeState(SECOND_HOME);
    // Machines share a project through its repository, which needs a remote to be named by.
    const workspace = await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(T3_HOME, "workspaces"), { recursive: true });
        const directory = yield* fs.makeTempDirectory({
          directory: path.join(T3_HOME, "workspaces"),
          prefix: "demo-",
        });
        yield* fs.writeFileString(path.join(directory, "README.md"), "");
        return directory;
      }),
    );
    const git = (args: ReadonlyArray<string>) => runPromise(run("git", args, { cwd: workspace }));
    await git(["init", "--quiet", "--initial-branch=main"]);
    await git(["remote", "add", "origin", "https://github.com/scenario/demo.git"]);
    await git(["add", "--all"]);
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
    await runPromise(primary.cli(["project", "add", workspace, "--title", "demo"]));
    const server = startSecondServer(app.baseUrl ?? "");
    try {
      const { host, token } = await server.ready;
      await runPromise(second.cli(["project", "add", workspace, "--title", "demo"]));

      await t3.open("/settings/connections");
      await screen.getByRole("button", "Add environment").tap();
      const dialog = screen.getByRole("dialog");
      await dialog.getByPlaceholder("backend.example.com").fill(host);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", "Add environment").tap();
      // The map is the default view; its rows carry no actions menu.
      await screen.getByRole("button", "List", { exact: true }).tap();
      await expect(screen.getByRole("button", "More actions for Scenario")).toBeVisible({
        timeout: 60_000,
      });
      await app.open("/");
      // Shift adds a model to the draft instead of replacing it.
      await screen.getByRole("button", "Showcase", { exact: false }).first().tap();
      await browser.keyboard.type("Plan and reads");
      await browser.keyboard.press("Shift+Enter");
      await browser.keyboard.press("Escape");
      const models = screen.getByRole("button", "Showcase, Plan and reads", { exact: false });
      await expect(models.first()).toBeVisible();

      // Both machines are named Scenario; the draft runs on the checked one.
      const runOn = () => screen.getByText("Scenario").last().tap();
      const machine = (index: number) => browser.locator('[role="menuitemradio"]').nth(index);
      await runOn();
      const target = (await machine(0).getAttribute("aria-checked")) === "true" ? 1 : 0;
      await machine(target).click();
      await runOn();
      await expect(machine(target)).toHaveAttribute("aria-checked", "true");
      await browser.keyboard.press("Escape");

      await app.screenshot("after-machine-switch");
      await expect(models.first()).toBeVisible();
    } finally {
      await server.stop();
      await runPromise(primary.cli(["project", "remove", workspace, "--force"]));
    }
  },
);
