import { expect } from "e2e";

import { run } from "./shell.ts";
import { runPromise } from "./lathe.ts";
import { IOS, test } from "./lathe-mobile.ts";

// The Git menu shows 12 units, "…" and the last 11; each emoji straddles one cut.
const BRANCH = "feature/abc😀-long-branch-name-😀-for-menus";

test(
  "The Git menu's branch title keeps whole characters at both cuts",
  IOS,
  async ({ lathe, app, screen }) => {
    const project = await lathe.project("demo");
    await runPromise(run("git", ["checkout", "--quiet", "-b", BRANCH], { cwd: project }));
    await lathe.thread({ project, title: "Branch work", messages: ["first"] });
    // A local simulator keeps the last run's pairing.
    await app.clearState().catch(() => {});
    await lathe.open();

    await screen.getByText("Branch work", { exact: false }).first().tap({ timeout: 120_000 });
    await screen.getByRole("button", "Git controls").tap({ timeout: 60_000 });
    const title = screen.getByText("feature/abc", { exact: false }).first();
    await title.waitFor({ timeout: 30_000 });
    await app.screenshot("git-menu");
    await expect(title).toHaveText("feature/abc…-for-menus, Clean");
  },
);
