import { expect } from "e2e";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

test(
  "A new worktree thread in a repository without a remote starts from main",
  WEB,
  async ({ t3, app, screen }) => {
    const cwd = await t3.project("demo", {
      "t3.json": JSON.stringify({ defaultThreadEnvMode: "worktree" }),
    });
    await runPromise(run("git", ["checkout", "-b", "feature"], { cwd }));

    await t3.open();
    const workspace = screen.getByRole("combobox", "Workspace", { exact: true });
    await expect(workspace).toContainText("New worktree");
    const base = screen.getByRole("combobox", /^Branch: From /).first();
    await base.waitFor();

    await app.screenshot("new-worktree-base");
    await expect(base).toHaveAccessibleName(/^Branch: From main\b/);
  },
);
