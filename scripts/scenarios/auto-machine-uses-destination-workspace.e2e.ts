import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { run } from "./shell.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

test(
  "Automatic machine selection uses the chosen project's workspace default",
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
      const remoteProject = await second.state.project("demo", repository);
      await runPromise(run("git", ["branch", "-m", "remote-base"], { cwd: remoteProject }));
      await runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* rpcClient(SECOND_HOME, host);
            yield* client["server.updateSettings"]({ patch: { defaultThreadEnvMode: "worktree" } });
          }),
        ),
      );

      await t3.open();
      const workspace = screen.getByRole("combobox", "Workspace", { exact: true });
      await workspace.getByText("Current checkout").waitFor({ timeout: 60_000 });
      await screen.getByRole("textbox").fill("Plan the next change");
      const draftPath = new URL(await browser.url()).pathname;
      await app.open("/settings/connections");
      await screen.getByRole("button", "Add environment").tap();
      const dialog = screen.getByRole("dialog");
      await dialog.getByPlaceholder("backend.example.com").fill(host);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", "Add environment").tap();

      await screen.getByRole("switch", "Automatically balance load").tap();
      await screen.getByRole("button", /^Load balancing/).tap();
      await screen.getByRole("combobox", "Scenario load preference").first().tap();
      await screen.getByRole("option", "Manual only", { exact: true }).tap();

      await app.open(draftPath);
      const runOn = screen.getByRole("combobox", "Run on", { exact: true });
      await runOn.getByText("Auto balance", { exact: true }).waitFor({ timeout: 60_000 });
      await screen
        .getByRole("combobox", /^Branch: (From )?remote-base/)
        .first()
        .waitFor({ timeout: 60_000 });
      await app.screenshot("workspace-after-auto-machine-selection");
      await expect(workspace).toHaveText("New worktree");
    } finally {
      await server.stop();
    }
  },
);
