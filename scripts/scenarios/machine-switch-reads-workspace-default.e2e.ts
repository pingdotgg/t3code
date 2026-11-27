import { expect } from "e2e";

import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { run } from "./shell.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

test(
  "The first switch to another machine uses that checkout's project file workspace default",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const repository = {
      ".git/config": '[remote "origin"]\n\turl = https://github.com/scenario/demo.git\n',
    };
    await t3.project("demo", repository);
    const second = makeState(SECOND_HOME);
    const server = startSecondServer(app.baseUrl ?? "");
    try {
      const { host, token } = await server.ready;
      const remoteProject = await second.state.project("demo", {
        ...repository,
        "t3.json": JSON.stringify({ defaultThreadEnvMode: "worktree" }),
      });
      await runPromise(run("git", ["branch", "-m", "remote-base"], { cwd: remoteProject }));

      await t3.open();
      const workspace = screen.getByRole("combobox", "Workspace", { exact: true });
      await workspace.getByText("Current checkout").waitFor();
      await screen.getByRole("combobox", "Branch: main", { exact: true }).first().waitFor();
      await screen.getByRole("textbox").fill("Plan the next change");
      const draftPath = new URL(await browser.url()).pathname;

      await app.open("/settings/connections");
      await screen.getByRole("button", "Add environment").tap();
      const dialog = screen.getByRole("dialog");
      await dialog.getByPlaceholder("backend.example.com").fill(host);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", "Add environment").tap();
      await screen.getByRole("button", "List", { exact: true }).tap();
      await screen.getByRole("button", "More actions for Scenario").waitFor({ timeout: 60_000 });
      await app.open(draftPath);

      const runOn = screen.getByRole("combobox", "Run on", { exact: true });
      await runOn.tap();
      // Both servers use the scenario label. The primary machine is listed first.
      const remote = screen.getByRole("option", "Scenario", { exact: true }).nth(1);
      await remote.tap();
      await screen
        .getByRole("combobox", /^Branch: (From )?remote-base/)
        .first()
        .waitFor();

      await app.screenshot("workspace-after-first-machine-switch");
      await expect(workspace).toHaveText("New worktree");
    } finally {
      await server.stop();
    }
  },
);
